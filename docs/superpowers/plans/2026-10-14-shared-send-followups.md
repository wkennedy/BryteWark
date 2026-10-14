# Shared-account sending follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the items left open by `2026-10-13-shared-account-sending.md`: a strict sub-address match for group sends, group identities as the default sender, unsubscribe and read receipts sent from the group that received the mail, and four small fixes.

**Architecture:** Each fix builds on what PR #22 added: composite ids `${jmapAccountId}/${identityId}`, `buildSendIdentities`, `routeOfIdentity`, `sendRouted` and `RoutedSendError`. There is no new storage and no schema change.

**Tech Stack:** TypeScript, React Native/Expo, JMAP (Stalwart 0.16), vitest (node env, `.ts` tests only; component tests use `src/components/email/__tests__/hook-harness.ts`).

**Spec:** There is no separate spec. The authorities are the "Left from shared-account sending" list in `NEXT-SESSION.md` and the decisions recorded in `docs/superpowers/plans/2026-10-13-shared-account-sending.md`: D1-A (one From list), D2-A (drafts in your own Drafts), D4-A (the copy goes to the group's Sent, and the send is refused without folders), D5-B (refused offline) and D6-A (a reply defaults to the group identity).

## Global Constraints

- Ids collide across JMAP accounts. Never look up an identity, email or mailbox id outside its own account's scope.
- A send from a group identity always goes through the group-sender check:
  - the group's identity is re-read;
  - its Sent and Drafts are resolved;
  - the From and envelope addresses are checked against it.
  - If any of these fail, it is refused with `RoutedSendError` and nothing is created on the server.
- A group send is refused offline (D5-B).
- `opScope()` and the `jmapClient.accountId` getter throw while disconnected. Use `connectedAccountId` where the code may run offline.
- New strings are added as `t('key', 'English fallback')` with single-brace placeholders (`{account}`), then `npm run i18n:harvest`.
- Gate:
  - `npm run typecheck && npm test && npm run i18n:check`
  - `TZ=Asia/Tokyo npm test`
  - `PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx vitest run src/lib src/stores`
- Never contact the user's real mail server.
- Commit trailer:
  - `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  - `Claude-Session: https://claude.ai/code/session_01AdqB9PokeySGSsJ92sqngP`

## Decisions (made in planning, open to the user's override)

- **P1, strict sub-address.** A From address passes for an identity when it is the identity's address, or the identity's full local part plus delimiter plus a non-empty tag, on the same domain.
  - `generateSubAddress` keeps the webmail behaviour: it replaces an existing tag.
  - Consequence: a group identity whose local part contains the delimiter (`team-sales@` with `-`, or `team+x@` with `+`) cannot use the composer's sub-address tag. That send is refused with the existing `from_override` message.
  - Own identities are unaffected, because the matcher is used only for group sends.
- **P2, default sender.**
  - The default-sender star in IdentitySettings also lists group identities, under their account's name.
  - Group rows are star-only: no edit or delete.
  - The stored value is the composite id, under the existing key (your own JMAP account id).
- **P3, unsubscribe and read receipts.**
  - When the message sits in a shared account and one of that account's identities received it (To, Cc or Bcc), the unsubscribe mail or receipt is sent from that group identity, filed in the group's Sent, after the group-sender check.
  - Otherwise nothing changes: it is sent from your own identity, into your own Sent.
  - When the group check refuses, the send is refused with the `RoutedSendError` message. It does not fall back to your own identity, because that would reveal your address to the list.
  - Amended after the final review (user decision): mail in a shared account is never answered from your own identity. It goes from that account's identity that received it, else its main identity (the first `!mayDelete` non-wildcard, else the first non-wildcard), through the group-sender check; with none (no send access, or catch-alls only) it is refused (`no_group_identity`) and the read receipt isn't offered. Mail in your own account is unchanged.
- **P4, signature.**
  - A group identity without a signature uses the signature of its own account's primary identity (`!mayDelete`, else the first), or none.
  - It never uses yours.
- **P5, failed undo restore.**
  - The undo itself has already succeeded.
  - If moving the message back to Drafts or reopening it fails, the user sees an alert, `Sending was cancelled, but the message couldn't be reopened. It is still in {folder}.`, where `{folder}` is the account name's Sent for a group, else "Sent".
  - There is no automatic retry.

## Review Focus

1. **Delimiter `-` with a hyphenated group address.** `team-sales@` must refuse `team-ops@` and accept `team-sales-ops@`. (Task 1)
2. **Your own and a group identity both received the mail** (you plus team@ on To), when the mail sits in the group. The group identity wins. When the mail sits in your own account, your own identity wins. (Task 4)
3. **A default sender naming a group identity that has since gone.** The composer falls back exactly as it does for a missing own default and never throws. (Task 3)
4. **Offline at the moment of unsubscribe or receipt from a group.** The action is refused with the offline message. It is not sent from your own account. (Task 4)
5. **Integer-like account ids** (own `"9"`, shared `"2"`) with a size-bounded cache. Your own entry survives the cut. (Task 2)

---

### Task 1: Strict sub-address match

**Files:**
- Modify: `src/lib/send-identities.ts` (`identitySendsAsOrSubaddress`, about lines 40-65)
- Test: `src/lib/__tests__/send-identities.test.ts` (describe `identitySendsAsOrSubaddress`), `src/lib/__tests__/routed-send.test.ts`

**Interfaces:** The signature is unchanged: `identitySendsAsOrSubaddress(identity, address, delimiter = '+')`.

- [ ] **Step 1:** Add the failing tests in `send-identities.test.ts`. Identity `{email:'team-sales@x.org'}` with delimiter `'-'`:
  - `team-ops@x.org` is false;
  - `team-sales-ops@x.org` is true;
  - `team@x.org` is false.

  Identity `{email:'team+x@x.org'}` with `'+'`:
  - `team+y@x.org` is false;
  - `team+x+y@x.org` is true.

  Existing cases stay green.
- [ ] **Step 2:** Run `npx vitest run src/lib/__tests__/send-identities.test.ts`. The new cases fail.
- [ ] **Step 3:** Compare the From's prefix before the cut with the identity's whole local part. The identity is never base-stripped. Domains are compared case-insensitively as now, and an empty tag is still refused. Update the comment to say why: a base compare lets a neighbouring address through.
- [ ] **Step 4:** Check `routed-send.test.ts:115` ("accepts a tagged override ... delimiter `-`"). If its identity's local part contains `-`, change the fixture so it pins the strict rule. Add a case: group identity `team-sales@` with delimiter `-` and From `team-ops@` rejects with `RoutedSendError` reason `from_override`, and no `EmailSubmission` is made.
- [ ] **Step 5:** Run the gate's first line. Commit with the message `fix: a group's sub-address must extend the group's full address`.

### Task 2: Three small fixes (signature, blob capability, cache order)

Each fix is its own commit, with its tests first.

**Files:**
- `src/lib/signature-utils.ts` (`signatureIdentityFor`)
- `src/screens/ComposeScreen.tsx` (about line 1332)
- `src/components/email/QuickReplyBox.tsx` (about line 217)
- `src/api/blob.ts` (`copyBlobs`, about line 306)
- `src/lib/identity-cache.ts` (`boundCount`, `writeIdentityCache`)
- Tests:
  - `src/lib/__tests__/signature-utils.test.ts`
  - `src/api/__tests__/blob.test.ts` (describe `copyBlobs`)
  - `src/lib/__tests__/identity-cache.test.ts`

**Interfaces:**
- Consumes `sameAccountIdentities(list, identity)` from `src/lib/composer-route.ts`.
- Consumes `jmapClient.hasAccountCapability(urn, accountId?)` (`jmap-client.ts:1427`).

**Fixes:**
- [ ] **2a, signature (P4).** Both call sites pass `sameAccountIdentities(list, identity)` as the pool instead of the whole merged list. `signatureIdentityFor` itself is unchanged.
  - Test: add a composer-route or signature-level test that a group identity without a signature, with an own primary that has one and a group primary without one, resolves to null. A group primary that has one resolves to the group primary.
  - Commit: `fix: a group identity without a signature never borrows yours`.
- [ ] **2b, blob capability.** `using` names `CAPABILITIES.BLOB` when `jmapClient.hasAccountCapability(CAPABILITIES.BLOB, to.accountId)` or the same for the source account is true. It falls back to the session level, as `hasAccountCapability` already does.
  - Tests:
    - The capability is named when only the target account advertises it.
    - The capability is not named when neither the session nor either account advertises it.
    - Update the existing mock of `hasCapability` to the new call.
  - Commit: `fix: Blob/copy names the blob capability when either account advertises it`.
- [ ] **2c, cache order.** `boundCount` returns an ordered array of `[jmapAccountId, AccountIdentities]` pairs, own first. `writeIdentityCache`'s size loop iterates it. `readIdentityCache` returns an object as before, and its callers are unchanged.
  - Test: with own `'9'` and shared `'2'`, each holding identities whose JSON together exceeds `MAX_IDENTITY_CACHE_CHARS`, your own account's identities are kept and the shared ones are cut.
  - Commit: `fix: the identity cache keeps your own account first even with numeric account ids`.
- [ ] Gate first line, then commit each fix.

### Task 3: Group identities as the default sender

**Files:**
- Modify: `src/components/settings/IdentitySettings.tsx`
- Test: `src/components/settings/__tests__/identity-settings-default.test.ts` (new, using the hook harness)
- Strings: in `locales/rn/en.json` via harvest.

**Interfaces:**
- Consumes:
  - `useSettingsStore(s => s.sendAccounts)`;
  - `buildSendIdentities(own, accounts)` and `groupSendIdentities` from `src/lib/send-identities.ts`, built the way `QuickReplyBox.tsx:152-166` builds them;
  - the `IdentitySheet` grouping, as the visual precedent for account headers.
- The setting stays `preferredIdentityIds: Record<ownJmapAccountId, identityId | compositeId>`.

**Steps:**
- [ ] **Step 1, tests first:**
  - With `sendAccounts` holding your own account and group "Team" with team@, the screen renders a "Team" section with a team@ row that has a star and no edit or delete controls.
  - Pressing the star stores `preferredIdentityIds[own] = '<teamAccount>/<id>'`.
  - The own rows are unchanged: they keep edit and delete, and starring one stores the plain id.
  - A stored composite id shows its star as filled.
  - Your hidden duplicate of team@ (the `aliases` entry) is not listed separately. A stored plain id that is aliased to the group row shows the group row as starred.
- [ ] **Step 2:** Implement. Group sections appear only when `sendAccounts` holds shared accounts, so the screen is unchanged with none. The section header uses the account name, and your own section uses the existing `email_composer.own_account` string.
- [ ] **Step 3:** Add a test in `composer-route.test.ts`, or the composer's existing default-resolution test, for this case: a stored composite default whose group identity is absent from the list falls back the way a missing own default does. Find where `ComposeScreen.tsx:1281-1288` resolves the default. If it is inline, extract it as `pickDefaultIdentityId(list, aliases, preferredId, activeEmail): string | undefined` in `composer-route.ts` and test it there.
- [ ] **Step 4:** Gate first line. Commit with the message `feat: a group identity can be the default sender`.

### Task 4: Unsubscribe and read receipts from the receiving group

**Files:**
- Create: `src/lib/group-sender.ts`, holding `verifyGroupSender`, extracted from `sendRouted`, and `receivingSendIdentity`.
- Modify:
  - `src/lib/routed-send.ts` (use `verifyGroupSender`);
  - `src/components/email/UnsubscribeBanner.tsx` (about lines 109-132);
  - `src/components/email/ReadReceiptBanner.tsx` (about lines 66 and 83-110).
- Test:
  - `src/lib/__tests__/group-sender.test.ts` (new);
  - `src/components/email/__tests__/banners-own-account.test.ts`, whose shared-account cases are rewritten to the new behaviour, plus own-mail cases that are unchanged;
  - `src/lib/__tests__/routed-send.test.ts`, which must stay green unchanged.

**Interfaces:**
- `verifyGroupSender(at: OpScope, route: {jmapAccountId; identityId}, addresses: (string|undefined)[], delimiter: string, accountName: string, fromAddress: string): Promise<{sentId: string; draftsId: string; identity: Identity}>`
  - It runs, in the existing order, the folders check (`no_folders`), the identity re-read (`identity_gone`) and the address check (`from_override`), and throws `RoutedSendError` on a failure.
  - `sendRouted` calls it, and its behaviour is unchanged.
- `receivingSendIdentity(list: SendIdentity[], email: Pick<Email,'to'|'cc'|'bcc'>, messageJmapAccountId: string | undefined, ownJmapAccountId: string): SendIdentity | undefined`
  - When the message's account is shared, it returns the identity of that account that received the mail, using `findReceivingIdentity` semantics but without the fall back to `[0]`.
  - Otherwise it returns `undefined`, meaning the caller keeps its existing own-identity path.

**Steps:**
- [ ] **Step 1:** Tests for `receivingSendIdentity` (Review Focus 2) and for `verifyGroupSender` (each refusal, then success). Run them; they fail.
- [ ] **Step 2:** Implement `group-sender.ts`. Refactor `sendRouted` to use it, and confirm `routed-send.test.ts` passes untouched.
- [ ] **Step 3, UnsubscribeBanner (mailto):**
  - If `receivingSendIdentity` returns a group identity:
    - offline: refuse with `RoutedSendError('offline', …)` through the existing `sendErrorAlert`;
    - online: send through `sendRouted`, with no attachments and `draftAccountId` left as your own.
  - Otherwise keep today's path.
  - The list is built from `sendAccounts` as in `QuickReplyBox`.
- [ ] **Step 4, ReadReceiptBanner:**
  - If `receivingSendIdentity` returns a group identity:
    - offline: refuse;
    - online: call `verifyGroupSender` with the MDN From, then `sendReadReceipt` with `accountId: inAccount(at, route.jmapAccountId)`, the group's `sentId` and `route.identityId`. MDN From and `originalRecipient` are the group address.
  - The `$mdnsent` flag is set in the message's account, as now.
  - "Always" mode follows the same rule. A refusal in "always" mode is logged and not alerted, matching how that mode handles a failed send today.
  - Check the existing code: if "always" mode alerts today, keep its behaviour.
- [ ] **Step 5:** Banner tests. A group message to team@:
  - unsubscribe and receipt go to the group account's Sent, from team@;
  - offline, they are refused, and no own-account submission is made;
  - with the group's Sent missing, they are refused with `no_folders`, and no own-account fallback happens.

  A group message addressed only to you: unchanged (own account).
- [ ] **Step 6:** Gate first line. Commit with the message `feat: unsubscribe and read receipts for group mail are sent from the group`.

### Task 5: Tell the user when an undone send can't be reopened

**Files:**
- Create: `src/lib/undo-reopen.ts`
- Modify: `src/components/UndoSnackbar.tsx` (`onUndo`, about lines 113-128)
- Test: `src/lib/__tests__/undo-reopen.test.ts`

**Interfaces:**
- `reopenUndoneSend(send: PendingUndoSend, deps: { restore: () => Promise<ComposeDraftContext>; open: (draft) => void; alert: (title: string, message: string) => void; t: TFunction; accountName?: string }): Promise<void>`
  - It calls `open` on success.
  - On a throw, it logs as now and calls `alert` with the P5 copy.
- `UndoSnackbar` wires `restoreUndoneSend`, navigation, `Alert.alert` and `t`. For a group send, the account name comes from the `sendAccounts` entry.

**Steps:**
- [ ] **Step 1:** Write the tests:
  - success opens the draft and does not alert;
  - a rejecting `restore` for a group send alerts with the account name's Sent;
  - an own send alerts with "Sent".
- [ ] **Step 2:** Implement and wire it.
- [ ] **Step 3:** Gate first line. Commit with the message `fix: say so when an undone send can't be reopened`.

### Task 6: Docs and full gate

- [ ] **CHANGES.md:** add an entry at the top, covering user-visible changes only.
- [ ] **Roadmap "Left open"** in `docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md`:
  - remove the items this closes;
  - add P1's consequence (a group address containing the delimiter can't take a composer tag) as left open.
- [ ] **README:** update it only if it claims anything about these items. Grep for "unsubscribe", "read receipt" and "default sender" first.
- [ ] Run the full gate: all three lines.
- [ ] Commit with the message `docs: record the shared-send follow-ups`.

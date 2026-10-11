# Shared-account mail hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop two live account-safety bugs on shared mail.
- Quick reply, the unsubscribe mailto and read receipts submit into a shared account with an identity id from the user's own account. Identity ids collide, so mail can go out under the wrong From.
- A draft opened from a shared account is destroyed by id in the user's own account. Email ids collide, so this can delete an unrelated message.

**Architecture:**
- Every submission on these paths goes from the user's own account, with that account's identity and its own Sent and Drafts, exactly as the full composer does today.
- Keywords (`$answered`, `$mdnsent`) are still set on the message in the message's own account.
- The composer remembers which JMAP account its draft lives in, and every destroy of that draft names that account.
- The queue replay refuses an identity whose address in the target account doesn't match the row's From.

**Tech Stack:** React Native/Expo, TypeScript, vitest, JMAP (Stalwart).

**Spec:** `.superpowers/sdd/2026-10-11-shared-account-mail-hotfix/research.md`, §3.6 (the bugs) and §4.10 (the invariants). User decision D8-A: hotfix separately, before the shared-sending feature.

## Global Constraints

- **Identity ids:** never look an identity id up in, or submit it to, an account other than the one whose `Identity/get` returned it.
- **Email ids:** never destroy, flag or read an email id in an account other than the one it came from.
- **Account scopes:** take the submission scope with `requireShownAccountScope(ownerAppAccountId)` (the user's own account), or `opScope()` where the component already checks the owner is active. Take keyword scopes with `inAccount(<that scope>, jmapAccountId)`.
- **Own folders:** use `ownMailboxes(mailboxes)` (`src/lib/mailbox-tree.ts:22`), as `ComposeScreen.tsx:677-688` does.
- **Queue state machine:** don't add new `HeldReason` values or bump the row `schema`.
- **Gate:** `npm run typecheck && npm test && npm run i18n:check`.

## Review Focus

1. **Quick reply on a shared message while offline:** the row must queue with the owner's own JMAP account, and `replyTo.jmapAccountId` stays the message's account.
2. **A queued row already on disk** from the old quick reply (a shared `jmapAccountId` with an own identity id) must not send under the wrong From after the update. The replay check holds it, and the existing restamp may then move it to the primary.
3. **A shared draft that is never autosaved and then sent or discarded:** the destroy goes to the draft's account, not the primary.
4. **A shared draft queued offline:** `draftId` is put on the row only when the draft's account equals the row's `jmapAccountId`.
5. **The read receipt's automatic path** goes through the same send and is fixed the same way.

---

### Task 1: Submit quick reply, unsubscribe and read receipts from the user's own account

**Files:**
- Modify: `src/components/email/QuickReplyBox.tsx:144-266` (identity, Sent/Drafts, queue account, send scope, undo record, `$answered` scope).
- Modify: `src/components/email/UnsubscribeBanner.tsx:104-122`.
- Modify: `src/components/email/ReadReceiptBanner.tsx:78-110`. `flagSent` keeps the message's account; `send` submits from the user's own account.
- Test: the existing tests next to each file, or new ones under `src/components/email/__tests__/`, following the repo's component-test idiom.

**Interfaces:**
- Produces nothing new for Task 2.

- [ ] **Step 1: Write the failing tests.** For a message whose `jmapAccountId` is a shared account `'f'` and an own account `'c'`, with own identities `[{id:'b', email:'bob@x'}]`:
  - **QuickReplyBox online:** `sendEmail` is called with an `accountId` scope whose `accountId === 'c'`, with Sent and Drafts ids from the *own* mailboxes (not the shared folder's), and with identity `'b'`. `patchKeywordsForEmails` is called with `['<email id>']` and a scope whose `accountId === 'f'`. `recordHeldSend` gets `accountId: 'c'`.
  - **QuickReplyBox offline:** the enqueued row has `jmapAccountId: 'c'` and `replyTo.jmapAccountId: 'f'`.
  - **UnsubscribeBanner mailto:** `sendEmail` gets an `accountId` of `'c'` and the own Sent id.
  - **ReadReceiptBanner:** `sendReadReceipt` gets `accountId.accountId === 'c'` and the own Sent id. `$mdnsent` is patched with `accountId === 'f'`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.** Replace `mailboxesOfAccount(mailboxes, jmapAccountId)` with `ownMailboxes(mailboxes)` for Sent and Drafts. Take the send scope once for the user's own account, and derive the keyword scope with `inAccount(scope, jmapAccountId)` on the same connection.
  - In QuickReplyBox, the queue account is the owner's own account: the existing `queueJmapAccountId({appAccountId, jmapAccountId: ''}, …)` fallback, now used unconditionally.
  - Keep `jmapClient.undoSendHold(sendDelaySeconds, <own account id>)`.
  - Update the comments that say "the message's account".
- [ ] **Step 4: Run the tests, then the gate.** Both pass.
- [ ] **Step 5: Commit** (`fix: send quick replies, unsubscribe mail and read receipts from your own account`).

### Task 2: Destroy a draft only in the account it lives in

**Files:**
- Modify: `src/api/email.ts`:
  - `createDraft` (`:2157-2185`): add a 5th parameter `previousDraftAccount?: AccountRef`. When it is given, the previous draft is destroyed in `inAccount(at, <its account id>)`, or in the scope it names. When it is absent, the behaviour is unchanged.
  - `SendEmailOptions`: add `draftAccountId?: string`. The destroy at `:2139-2145` then uses `inAccount(at, opts.draftAccountId)`.
- Modify: `src/screens/ComposeScreen.tsx`. Next to `draftIdRef` (`:1453`), add `draftAccountRef = useRef<string | null>(draft?.jmapAccountId ?? null)`, where null means the user's own account. Then:
  - **Autosave** (`:1709`): pass `draftAccountRef.current ?? undefined` as `previousDraftAccount`, and after a successful save set `draftAccountRef.current = null`, because the new copy is in the own Drafts.
  - **Discard-on-leave** (`:1816-1835`): every destroy of `draftIdRef` names the draft's account the same way.
  - **Online send** (`:2733`): pass `draftAccountId`.
  - **Offline enqueue** (`:2691`): put `draftId` on the row only when the draft's account (own when null) equals the row's `jmapAccountId`. Otherwise omit it; the shared draft is left in place.
  - Grep the file for every other use of `draftIdRef` and apply the same rule.
- Modify: `src/lib/send-queue-replay.ts`. Before submitting in `sendOne` (around `:463-520`), read the identities of `entry.jmapAccountId` (`getIdentities(<scope>)`, `src/api/identity.ts`). If none has `id === entry.identityId` and an email equal (case-insensitive) to `entry.outgoing.from[0].email`, hold the row as `'account_unavailable'`, the way the replay already holds an unserved account, and don't submit.
- Test: `src/api/__tests__/email*.test.ts`, the composer's existing tests if any (otherwise unit-test the pure enqueue-draft rule as an exported helper in `src/lib/composer-account.ts`), and `src/lib/__tests__/send-queue-replay*.test.ts`.

**Interfaces:**
- Produces:
  - `createDraft(email, draftsMailboxId, previousDraftId?, account?, previousDraftAccount?: AccountRef): Promise<string>`;
  - `SendEmailOptions.draftAccountId?: string`;
  - `queueDraftId(draftId: string | null, draftAccountId: string | null, ownAccountId: string, rowAccountId: string): string | undefined` in `src/lib/composer-account.ts`.

- [ ] **Step 1: Write the failing tests:**
  - **createDraft:** with `previousDraftId 'm1'` and `previousDraftAccount 'f'`, `Email/set` create runs in the own account and the destroy of `'m1'` runs with `accountId 'f'`.
  - **sendEmail:** with `draftId 'm1'` and `draftAccountId 'f'`, the destroy has `accountId 'f'`.
  - **queueDraftId:** `('m1', 'f', 'c', 'c')` → undefined; `('m1', null, 'c', 'c')` → `'m1'`; `('m1', 'c', 'c', 'c')` → `'m1'`.
  - **Replay:** a row with `jmapAccountId 'f'`, `identityId 'b'` and From `bob@x`, where account f's identity `'b'` is `team@x`, ends held `account_unavailable` with no `EmailSubmission/set` sent. A row whose identity matches still sends.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement as described above.**
- [ ] **Step 4: Run the tests, then the gate.** Both pass.
- [ ] **Step 5: Commit** (`fix: destroy a shared-account draft in its own account, and hold a queued send whose identity doesn't match`).

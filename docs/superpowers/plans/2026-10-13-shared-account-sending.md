# Shared-account sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parity item `docs/parity/04-composer-send.md:74`. Picking a group address such as team@ in the From list sends from the group's JMAP account, and the copy goes to the group's Sent, as in webmail.

**Architecture:**
- **Identities:**
  - A batched `Identity/get` reads your own account and every shared account that advertises submission.
  - A shared account counts as sendable only if its `Identity/get` succeeds.
  - A pure helper merges the lists into one From list:
    - A group identity gets the composite id `<jmapAccountId>/<identityId>`.
    - Your own duplicate of the same address is hidden, and an alias map points its old id at the group row.
  - Existing pickers, templates and preferences keep working on plain ids.
- **Sending:**
  - A routed-send orchestrator resolves the group's Sent and Drafts and checks the identity in the group account.
  - It copies attachment blobs across with `Blob/copy`, then calls the existing `sendEmail` with the group scope.
  - Anything missing refuses the send. It never falls back to your own account.
- **Drafts** always stay in your own Drafts (D2). Offline sends from a group identity are refused (D5-B).

**Tech Stack:** React Native/Expo, TypeScript, vitest (node environment, `src/**/__tests__/**/*.test.ts`), JMAP on Stalwart 0.16.

**Spec:** `.superpowers/sdd/2026-10-10-shared-account-sending/research.md`. It is git-ignored and local only; read §2 (server facts), §4 (design) and §5 (decisions). Its line numbers predate the hotfix (#21). Use the file:line references in this plan instead.

**User decisions (binding):**
- **D1-A:** one From list. A group address routes to the group account, and your own duplicate is hidden.
- **D2-A:** drafts always go in your own Drafts.
- **D3-A:** a From change moves nothing.
- **D4-A:** the copy goes to the group's Sent. With no Sent or Drafts there, the send is refused.
- **D5-B:** an offline send from a group identity is refused ("Connect to send from team@").
- **D6-A:** a reply from a shared folder defaults to the group identity.
- **D7-A:** identity cache v2 is one row per app account, holding a map of JMAP account to identities.

## Global Constraints

- **Identity ids:** never look up or submit an identity id in an account other than the one whose `Identity/get` returned it. Identity ids collide across accounts: `b` is bob@ in his own account and team@ in the group's.
- **Composite ids:** a group identity's id in the app is `${jmapAccountId}/${identityId}`. JMAP ids are `[A-Za-z0-9_-]`, so `/` never appears in a real id. Only `routeOfIdentity()` (Task 1) turns a composite id back into a server id.
- **Email and mailbox ids:** never destroy, flag or file an email or mailbox id in an account other than its own. Target folders come from `resolveSendMailboxes(scope)` (`src/api/sent-lookup.ts:129`), which returns raw ids. Store ids for shared folders are `<accountId>:<rawId>`, so never pass a store id to the server.
- **Capability is not permission:** a shared account is sendable only when its `Identity/get` succeeds. Never use `submissionAccountId()`'s primary fallback for a routed send.
- **The server does not check header From against the identity** (research E5, E9). Before a routed submit, the client checks that the identity, re-read from the group account, sends as the From address, and as `envelopeMailFrom` when one is set.
- **No silent fallback:** a routed send that cannot complete is refused with a `RoutedSendError`. It never re-sends from your own account.
- **One connection:** the routed scope is `inAccount(opScope(), targetAccountId)`. The blob copy, identity check, send, draft destroy and reply flag all use scopes with that `gen`.
- **Queue:** don't add a `HeldReason`, don't bump the row `schema`, and don't change `restampTarget`. Under D5-B no queued row ever names a group account.
- **Copy (exact English):**
  - offline: `Connect to send from {{address}}.`
  - no folders: `{{account}} has no Sent or Drafts folder, so mail can't be sent from {{address}}.`
  - identity gone: `You can no longer send from {{address}} in {{account}}.`
  - blob copy: `The attachments couldn't be copied to {{account}}. Nothing was sent.`
  - your own account's section header in the sheet: `Your account`.
- **i18n:** write `t('key', 'English')` in code, then run `npm run i18n:harvest`. Keys go under `email_composer.*`.
- **Gate (every task):** `npm run typecheck && npm test && npm run i18n:check`. Before the final review, also run `TZ=Asia/Tokyo npm test` and `PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx vitest run src/lib src/stores`.
- **Safety:** never contact the user's real mail server. The only live server is the throwaway local Stalwart in Task 8.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The preferred or template identity is your hidden own team@** (its id was saved before this change). The composer must open on the routed team@ row through the alias map, not on a missing id or the first identity. Test: Task 6.
2. **A From override or sub-address on a routed identity** (team+tag@, or a custom From). The submission identity is picked only from the routed account's identities. If none sends as the From, the send is refused, so it is never paired with an own-account identity. Tests: Tasks 4 and 6.
3. **A folder-only share** advertises submission, but its `Identity/get` is `forbidden`. It is not listed, and your own copy of that address stays visible and sends from your account as today. Test: Task 1.
4. **The list came from the offline cache, or the connection drops.** A routed identity chosen offline is refused with the "Connect to send from" message and nothing is queued. The same draft then sends from your own identity if you switch to it. Tests: Tasks 6 and 7.
5. **Undo, or Send now, on a held routed send** acts in the group account. The restored draft opens and its first autosave moves it to your own Drafts, which is the hotfix behaviour. Test: Task 6 (`recordHeldSend` gets `accountId`).

---

### Task 1: Sendable identities and the merged From list

**Files:**
- Modify: `src/api/identity.ts` (add `getSendIdentities`).
- Create: `src/lib/send-identities.ts`.
- Modify: `src/lib/send-queue-replay.ts:489-498`. `identityMatches` calls `identitySendsAs`; its behaviour doesn't change.
- Test: `src/api/__tests__/identity.test.ts`, `src/lib/__tests__/send-identities.test.ts`.

**Interfaces:**
- Produces in `src/api/identity.ts`:
  ```ts
  export interface AccountIdentities { name: string; identities: Identity[] }
  /** Keyed by JMAP account id; always holds the scope's own account. */
  export type SendableIdentities = Record<string, AccountIdentities>;
  export async function getSendIdentities(at?: OpScope): Promise<SendableIdentities>;
  ```
  - It sends one request: `Identity/get` for `at.accountId` (your own), plus one per other session account whose own `accountCapabilities` carry `CAPABILITIES.SUBMISSION`.
  - If your own call errors, it throws (`requireMethodResult`).
  - A shared call that returns an `error` response is left out, so the account is not sendable.
  - `name` is `jmapClient.getAccountName(id) ?? id`.
- Produces in `src/lib/send-identities.ts`:
  ```ts
  export type SendIdentity = Identity & { jmapAccountId: string; accountName: string };
  export function routedIdentityId(jmapAccountId: string, identityId: string): string; // `${a}/${i}`
  export function routeOfIdentity(identity: SendIdentity): { jmapAccountId: string; identityId: string };
  export function identitySendsAs(identity: Pick<Identity, 'email'>, address: string): boolean; // case-insensitive exact, or `*@domain` covers the domain
  export function buildSendIdentities(ownAccountId: string, accounts: SendableIdentities):
    { list: SendIdentity[]; aliases: Record<string, string> };
  export interface IdentitySection { jmapAccountId: string; label: string | null; identities: SendIdentity[] }
  export function groupSendIdentities(list: SendIdentity[], ownAccountId: string): IdentitySection[]; // own first, label null; then shared in list order, label = accountName
  ```
  - `buildSendIdentities` rules:
    - Your own identities keep their plain `id`.
    - A shared identity gets `id = routedIdentityId(account, id)`.
    - An own identity is hidden when a shared identity has the same lowercased `email`, and wildcard (`*@`) emails are never deduped. Its id is then recorded in `aliases[ownId] = <composite id>`.
    - When two shared accounts list the same address, the first account in `Object.keys` order wins, and the other's row is still listed.
    - Order: own identities first, then each shared account's.

- [ ] **Step 1: Write the failing tests.**
  - `send-identities.test.ts`, fixtures shaped like research S2/S4. Own account `d` has `b: bob@x` and `c: team@x`. Group `f` (name `team@x`) has `b: team@x`.
    - `buildSendIdentities('d', …)`:
      - `list.map(i => i.id)` equals `['b', 'f/b']`;
      - the `f/b` row has `jmapAccountId: 'f'` and `email: 'team@x'`;
      - `aliases` equals `{ c: 'f/b' }`.
    - With no shared accounts, the list is the own list with `jmapAccountId: 'd'`, and `aliases` is `{}`.
    - An own `*@x` wildcard is not hidden by a group `team@x`.
    - `routeOfIdentity(list[1])` equals `{ jmapAccountId: 'f', identityId: 'b' }`, and `routeOfIdentity(list[0])` equals `{ jmapAccountId: 'd', identityId: 'b' }`.
    - `identitySendsAs({email:'Team@X'}, 'team@x')` is true. `identitySendsAs({email:'*@x'}, 'any@x')` is true. `identitySendsAs({email:'team@x'}, 'bob@x')` is false.
    - `groupSendIdentities` gives sections `[{jmapAccountId:'d', label:null}, {jmapAccountId:'f', label:'team@x'}]`.
  - `identity.test.ts`, `getSendIdentities`:
    - Mock `jmapClient.request` and a session where `d` is own, `f` advertises submission, `g` advertises submission but answers `['error', {type:'forbidden'}, …]`, and `h` has no submission.
    - The request carries exactly three `Identity/get` calls (d, f, g), and the result has keys `['d', 'f']`.
    - An error on `d` rejects.
    - The request is made with `{ gen: at.gen }`.
- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/send-identities.test.ts src/api/__tests__/identity.test.ts`. Expected: FAIL (module or export missing).
- [ ] **Step 3: Implement** both modules. Point `identityMatches` in `send-queue-replay.ts` at `identitySendsAs`.
- [ ] **Step 4: Run** the same tests, then `npx vitest run src/lib/__tests__/send-queue-replay.test.ts`. Expected: all PASS.
- [ ] **Step 5: Commit:** `feat: list the identities each shared account lets you send from, merged into one From list`.

### Task 2: Identity cache v2

**Files:**
- Modify: `src/lib/identity-cache.ts`, `src/stores/account-data-cleanup.ts:120` (no change if `removeIdentityCache` covers both keys).
- Test: `src/lib/__tests__/identity-cache.test.ts`. Update `src/stores/__tests__/auth-store-cleanup-race.test.ts:62` for the new prefix.

**Interfaces:**
- Consumes: `SendableIdentities` (Task 1).
- Produces:
  ```ts
  export const IDENTITY_CACHE_PREFIX = 'webmail:identities:v2:';
  export const LEGACY_IDENTITY_CACHE_PREFIX = 'webmail:identities:v1:';
  export async function readIdentityCache(appAccountId: string, ownJmapAccountId: string | null): Promise<SendableIdentities>;
  export async function writeIdentityCache(appAccountId: string, accounts: SendableIdentities): Promise<void>;
  export async function removeIdentityCache(appAccountId: string): Promise<void>; // removes v2 and v1
  export interface ComposerIdentities { accounts: SendableIdentities; source: 'fresh' | 'cache' | 'none'; error: string | null }
  export async function loadComposerIdentities(appAccountId: string | null | undefined, ownJmapAccountId: string | null, fetch: () => Promise<SendableIdentities>): Promise<ComposerIdentities>;
  ```
  - Stored shape: `{ [jmapAccountId]: { name: string; identities: Identity[] } }`.
  - `MAX_CACHED_IDENTITIES` (50) and `MAX_IDENTITY_CACHE_CHARS` apply to the whole row, across all accounts, with your own account's identities kept first.
  - `cleanIdentity` is applied to every entry. Non-object accounts, and accounts without an identity array, are dropped.
  - **v1 migration on read:** if there's no v2 row and a v1 row exists and `ownJmapAccountId` is non-null, read v1 as `{ [own]: { name: own, identities } }`. With a null own id, v1 is ignored. The v1 key is removed on the next successful write.
  - `'none'` means the result has no identities in any account.

- [ ] **Step 1: Write the failing tests.**
  - A v2 round-trip keeps two accounts.
  - A corrupt or non-object row reads as `{}`.
  - The 50-identity bound spans accounts, and your own account's identities survive when the bound cuts.
  - v1 `[bob]` with own `d` reads as `{ d: { identities: [bob] } }`; with own `null` it reads as `{}`.
  - A write removes the v1 key.
  - `removeIdentityCache` removes both keys.
  - `loadComposerIdentities`:
    - a fetch failure falls back to the cache with `source: 'cache'`;
    - no owner means no cache read or write.
- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/identity-cache.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Callers are fixed in Tasks 3 and 6, so until then typecheck fails only at those call sites.
  - To keep the tree compiling in this commit, make the minimal call-site edits:
    - `settings-store.ts:1246` and `:1276` pass `{ [jmapClient.accountId]: { name: '', identities } }`;
    - `ComposeScreen.tsx:1107` wraps likewise and reads back `accounts[own]?.identities ?? []`.
- [ ] **Step 4: Run** the gate. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: cache each account's sending identities per JMAP account, migrating the old cache`.

### Task 3: Settings store holds the sendable accounts; IdentitySheet groups by account

**Files:**
- Modify: `src/stores/settings-store.ts:547-585` (state), `:1215-1280` (`fetchIdentities`, `ensureIdentities`, `refreshIdentities`), `:1542-1543` (reset).
- Modify: `src/components/IdentitySheet.tsx`.
- Test: the existing settings-store identity tests (find them with `grep -ln "fetchIdentities" src/stores/__tests__`), plus `src/lib/__tests__/send-identities.test.ts` for the sections (already done in Task 1).

**Interfaces:**
- Consumes: `getSendIdentities`, `buildSendIdentities`, `groupSendIdentities`, `SendIdentity`, and cache v2.
- Produces on `SettingsState`:
  - `sendAccounts: SendableIdentities;` set in the same `set()` as `identities`, under the same scope guard. Reset to `{}` alongside `identities`.
  - `identities` stays your own account's list (`sendAccounts[jmapClient.accountId].identities`), so IdentitySettings and the banners are unchanged.
  - `fetchIdentities` and `refreshIdentities` call `getSendIdentities(opScope())` in place of `getIdentities()`, then `writeIdentityCache(cacheAccount, accounts)`.
- Produces in IdentitySheet:
  - The props stay the same, but `identities: Identity[] | SendIdentity[]`, plus an optional `ownAccountId?: string`.
  - When `ownAccountId` is given and the list spans more than one `jmapAccountId`, it renders `groupSendIdentities` sections. The own section header is `t('email_composer.own_account', 'Your account')`, and the others show `accountName`.
  - Otherwise the flat list renders as today.
  - The selected check compares `identity.id` (composite ids keep collided ids apart).

- [ ] **Step 1: Write the failing store tests.**
  - With `getSendIdentities` mocked to `{ d: {…bob}, f: {…team} }`:
    - after `fetchIdentities()`, `sendAccounts` has both keys and `identities` is d's list;
    - the cache write got both accounts;
    - a scope change during the await leaves `sendAccounts` untouched (mirror the existing stale-scope test).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the store and sheet changes.
- [ ] **Step 4: Run** the gate. Expected: PASS. `screens-i18n.test.ts` must still pass for IdentitySheet, so the header goes through `t()`.
- [ ] **Step 5: Commit:** `feat: load shared accounts' identities with your own, and group them by account in the From sheet`.

### Task 4: Blob copy into the target account

**Files:**
- Modify: `src/api/blob.ts`.
- Test: `src/api/__tests__/blob.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export class BlobCopyError extends Error { constructor(public blobIds: string[]) }
  /** RFC 8620 §6.3 Blob/copy from `fromAccountId` into `to.accountId`, on `to`'s connection. Returns old id → new id. */
  export async function copyBlobs(fromAccountId: string, to: OpScope, blobIds: string[]): Promise<Record<string, string>>;
  ```
  - Empty `blobIds`: return `{}` and make no request.
  - `fromAccountId === to.accountId`: return the identity map and make no request.
  - Duplicates are copied once.
  - Any `notCopied` entry, or a missing id in `copied`, throws `BlobCopyError` with those ids.
  - `using` is `[CAPABILITIES.CORE]`. `Blob/copy` is core JMAP and needs no blob capability.

- [ ] **Step 1: Write the failing tests:**
  - the request is `['Blob/copy', { fromAccountId:'d', accountId:'f', blobIds:['x','y'] }, …]` on `{gen}`;
  - `{ copied: { x:'X', y:'Y' } }` returns `{ x:'X', y:'Y' }`;
  - `notCopied: { y: {type:'notFound'} }` throws `BlobCopyError` with `['y']`;
  - the empty and same-account cases make no request.
- [ ] **Step 2: Run** `npx vitest run src/api/__tests__/blob.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: copy blobs between accounts with Blob/copy`.

### Task 5: Routed send

**Files:**
- Create: `src/lib/routed-send.ts`.
- Modify: wherever `sendErrorAlert` lives (`grep -rn "export function sendErrorAlert" src`) to map `RoutedSendError` to the copy in Global Constraints.
- Test: `src/lib/__tests__/routed-send.test.ts`, plus the `sendErrorAlert` test file if one exists.

**Interfaces:**
- Consumes: `copyBlobs` and `BlobCopyError` (Task 4); `identitySendsAs` (Task 1); `getIdentities(at)`; `resolveSendMailboxes(at)`; `sendEmail` with `SendEmailOptions` (`src/api/email.ts:1885`).
- Produces:
  ```ts
  export type RoutedSendReason = 'offline' | 'no_folders' | 'identity_gone' | 'blob_copy';
  export class RoutedSendError extends Error { constructor(public reason: RoutedSendReason, public address: string, public account: string) }
  export interface RoutedSendParams {
    outgoing: OutgoingEmail;
    route: { jmapAccountId: string; identityId: string }; // from routeOfIdentity
    accountName: string;
    blobAccountId: string;      // where outgoing.attachments' blobs live (your own account)
    holdForSeconds?: number;
    draftId?: string;           // previous draft, destroyed after the submit
    draftAccountId?: string;    // its account (own, or the shared one it was opened from)
    base: OpScope;              // opScope() at send time; the routed scope is inAccount(base, route.jmapAccountId)
  }
  export async function sendRouted(p: RoutedSendParams): Promise<SendEmailResult & { accountId: string }>;
  ```
  - Order, every call on `at = inAccount(base, route.jmapAccountId)`:
    1. `resolveSendMailboxes(at)`. Missing `sentId` or `draftsId` throws `'no_folders'`.
    2. `getIdentities(at)`. The identity with `route.identityId` must exist, and `identitySendsAs` must hold for `outgoing.from[0].email` and for `outgoing.envelopeMailFrom` when set. Otherwise it throws `'identity_gone'`.
    3. `copyBlobs(blobAccountId, at, <every attachment blobId>)`, then rewrites `blobId`s on a copy of `outgoing`. A `BlobCopyError` throws `'blob_copy'`.
    4. `sendEmail(copy, route.identityId, sentId, holdForSeconds, { draftsMailboxId: draftsId, draftId, draftAccountId: draftAccountId ?? base.accountId, accountId: at })`.
  - It returns the result with `accountId: route.jmapAccountId`.
  - Nothing is created before step 4, so every refusal leaves no server state.
  - `draftAccountId` defaults to **your own** account, not the routed one, because drafts live in your own Drafts (D2).

- [ ] **Step 1: Write the failing tests** (mock `sendEmail`, `getIdentities`, `resolveSendMailboxes`, `copyBlobs`):
  - **Happy path:**
    - `sendEmail` gets identity `'b'`, Sent `'e'`, `draftsMailboxId: 'd'`, `accountId.accountId === 'f'` with the base `gen`, `draftAccountId === 'own'`, and attachments with copied blob ids;
    - `copyBlobs` was called with `('own', at, ['x'])`;
    - the result's `accountId` is `'f'`.
  - **`no_folders`:** `{ sentId: 'e' }` with no Drafts throws `RoutedSendError` `'no_folders'`, and `sendEmail` and `copyBlobs` are not called.
  - **`identity_gone`, collided id:** the group returns `[{id:'b', email:'team@x'}]` but `from` is `bob@x`. It throws `'identity_gone'`, and `sendEmail` is not called (research E5).
  - **`identity_gone`, id missing:** route identity `'c'`, which is absent in the group (research E4).
  - **`blob_copy`:** `copyBlobs` rejects with `BlobCopyError`, so it throws `'blob_copy'` and `sendEmail` is not called.
  - **Envelope:** `envelopeMailFrom: 'bob@x'` with group identity team@x throws `'identity_gone'`.
  - **Error copy:** `sendErrorAlert(new RoutedSendError('offline', 'team@x', 'Team'), t)` returns a message containing `Connect to send from team@x.`
- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/routed-send.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then run `npm run i18n:harvest`.
- [ ] **Step 4: Run** the gate. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: send from a group identity in the group's account, refusing when its folders, identity or attachments aren't there`.

### Task 6: Composer routes the send

**Files:**
- Modify: `src/screens/ComposeScreen.tsx`. Current anchors:
  - identity load: `:1095-1126`;
  - default choice: `:1248-1300`;
  - `primaryIdentity`: `:1302-1309`;
  - `submissionIdentity`: `:1595`;
  - DSN and REQUIRETLS: `:918-919`;
  - hold and schedule: `:2509`, `:2538`, `:2557`, `:2568`;
  - offline branch: `:2682-2741`;
  - online send: `:2747-2759`;
  - `recordHeldSend`: `:2804-2813`;
  - template: `:2385`;
  - IdentitySheet: `:3543-3548`.
- Create: `src/lib/composer-route.ts`. These are pure helpers, so the composer logic is testable without a renderer: there is no ComposeScreen harness, and tests are `.ts` only.
- Test: `src/lib/__tests__/composer-route.test.ts`.

**Interfaces:**
- Consumes: Tasks 1, 2, 3 and 5.
- Produces in `src/lib/composer-route.ts`:
  ```ts
  /** The id a saved preference or template names, after the hidden-duplicate alias. */
  export function resolveIdentityAlias(id: string | null | undefined, aliases: Record<string, string>): string | null;
  /** Identities eligible as the submission identity: only the chosen identity's own account. */
  export function sameAccountIdentities(list: SendIdentity[], chosen: SendIdentity): SendIdentity[];
  export type ComposerSendPlan =
    | { kind: 'own' }
    | { kind: 'routed'; route: { jmapAccountId: string; identityId: string }; accountName: string }
    | { kind: 'refuse'; error: RoutedSendError };
  export function planComposerSend(p: { submission: SendIdentity; ownAccountId: string; online: boolean }): ComposerSendPlan;
  // offline + routed → refuse 'offline' with address = submission.email, account = submission.accountName
  export function sendCapabilityAccountId(submission: SendIdentity | null, ownAccountId: string | undefined): string | undefined; // its jmapAccountId
  ```
- Composer changes:
  - **Identity load:** `loadComposerIdentities(owner?.appAccountId, ownAccountId, () => getSendIdentities(inAccount(opScope(), fetchAccountId)))`. The state becomes `identities: SendIdentity[]` via `buildSendIdentities`, and `aliases` is kept in a ref or state.
  - **Preferred and template:** `preferredIdentityIds[owner.jmapAccountId]` and `template.identityId` go through `resolveIdentityAlias` before matching. Draft, compose-from-shared and reply defaults run unchanged on the merged list. The hidden duplicate is gone, so an address match lands on the routed row (D6).
  - **Submission identity:** `pickSubmissionIdentity(sameAccountIdentities(identities, primaryIdentity), primaryIdentity, fromOverride?.email)`. Make `pickSubmissionIdentity` (`src/lib/envelope-sender.ts:26`) generic, `<T extends Identity>`, so it returns a `SendIdentity` without a cast.
  - **Capability checks:** DSN, REQUIRETLS, `undoSendHold`, `hasDelayedSend`, `getMaxDelayedSend` and `latestHoldDate` take `sendCapabilityAccountId(submissionIdentity ?? primaryIdentity, owner?.jmapAccountId)` in place of `owner?.jmapAccountId`.
  - **Offline:** before building the queued row, if `planComposerSend` gives `refuse`, show `sendErrorAlert(plan.error, t)` and return. Nothing is enqueued.
  - **Online:**
    - `own`: the current `sendEmail` call, unchanged.
    - `routed`: `sendRouted({ …, blobAccountId: at.accountId, draftId: draftIdRef.current ?? undefined, draftAccountId: draftAccountRef.current ?? undefined, base: at })`.
    - After success, the existing post-send code runs on the result: the reply flag stays on `inAccount(at, replyTo.jmapAccountId)`.
  - **Held sends:** `recordHeldSend(result, holdForSeconds, { …, identityId: route.identityId (routed) or the plain id (own), accountId: <routed jmapAccountId, or undefined for own> })`.
  - **IdentitySheet** gets `ownAccountId={owner?.jmapAccountId}`.
  - **Draft save is unchanged** (D2/D3). It always saves into your own Drafts.

- [ ] **Step 1: Write the failing tests** in `composer-route.test.ts`:
  - **Aliases:** `resolveIdentityAlias('c', { c: 'f/b' })` is `'f/b'`; `('b', {})` is `'b'`; `(null, …)` is `null`.
  - **Same account:** `sameAccountIdentities` with an own `*@x` wildcard and a routed `f/b` returns only `f/b` for the routed chosen identity. Review Focus 2: an override `team+tag@x` must not pick the own wildcard.
  - **Send plan:**
    - `planComposerSend` for own `b` (online or offline) gives `own`;
    - routed `f/b` online gives `routed` with route `{f, b}`;
    - routed `f/b` offline gives `refuse` with reason `'offline'` and address `team@x`.
  - **Capability account:** `sendCapabilityAccountId` of `f/b` is `'f'`, and with `null` it returns the own id.
- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/composer-route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, then wire ComposeScreen as listed.
- [ ] **Step 4: Run** the gate. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: the composer sends from a group identity in the group's account, and refuses it offline`.

### Task 7: Quick reply routes like the composer

**Files:**
- Modify: `src/components/email/QuickReplyBox.tsx`. The hotfix made it own-account at `:144-266`.
- Test: `src/components/email/__tests__/quick-reply-box.test.ts` (hook-harness idiom).
- Unsubscribe and read receipts stay own-account. They are personal actions; record this in Task 8's "Left open".

**Interfaces:**
- Consumes: `useSettingsStore().sendAccounts` (Task 3), `buildSendIdentities`, `planComposerSend`, `sendRouted`, and `sendErrorAlert`.
- Behaviour:
  - The reply identity is resolved over `buildSendIdentities(ownAccountId, sendAccounts).list` with the resolver it uses today.
  - A routed result sends with `sendRouted` (`blobAccountId` is the own account; there are no attachments).
  - It is refused offline with the "Connect to send from" alert, and nothing is queued.
  - `recordHeldSend` gets the routed `accountId`.
  - `$answered` stays on the message's account.
  - An own result behaves exactly as today.

- [ ] **Step 1: Write the failing tests.** Message in shared `f`, own `d`; `sendAccounts` `{ d: [bob b, team c], f: [team b] }`; message to `team@x`.
  - **Online:**
    - `sendRouted` is called with route `{ jmapAccountId: 'f', identityId: 'b' }`, and `sendEmail` is not called directly;
    - `patchKeywordsForEmails` scope `accountId === 'f'`;
    - `recordHeldSend` has `accountId: 'f'`.
  - **Offline:** `enqueue` is not called, and an alert with `Connect to send from team@x.` is shown.
  - **Own reply:** a message to `bob@x` keeps today's call shape. The existing hotfix tests still pass.
- [ ] **Step 2: Run** `npx vitest run src/components/email/__tests__/quick-reply-box.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the gate. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: quick reply sends from a group identity in the group's account`.

### Task 8: Live check against a throwaway Stalwart, and the docs

**Files:**
- Create: `scripts/stalwart-shared-send-it.sh`, and `src/api/__tests__/shared-send.it.test.ts`, skipped unless `STALWART_IT_URL` is set (`describe.skipIf(!process.env.STALWART_IT_URL)`).
- Modify:
  - `CHANGES.md` (new section at the top, and fix the header's "not merged yet" wording for #21);
  - `docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md` ("Left open");
  - `docs/parity/04-composer-send.md:74` (mark it done);
  - `PARITY_CHECKLIST.md` (counts);
  - `README.md` only if a claim about shared accounts changes.

**Script requirements:**
- **Container:**
  - Use the local image `bulwark-integration-stalwart:latest` (Stalwart 0.16). Never pull another image, and never contact a host other than localhost.
  - Name the container `bulwark-sharedsend-it-$$` and bind it to a random localhost port.
  - `trap` removes the container and its volumes on exit.
  - Leave any other `bulwark-*` container alone.
- **Provisioning:**
  - Users `alice`, `bob` and `carol` @example.org, and group `team@example.org` with bob as a member.
  - Also a folder-only share from alice to bob with `maySubmit`, if 0.16's admin API allows it. Otherwise skip that case and say so in the output.
  - The webmail kit (`/tmp/webmail/integration`) is gone. Find 0.16's admin or CLI commands from the image itself, and write the working commands into the script.
- **Run:** export `STALWART_IT_URL` and the credentials, then run `npx vitest run src/api/__tests__/shared-send.it.test.ts`.
- **No TLS bypass:** reach JMAP over the container's plain-HTTP listener, bound to 127.0.0.1 only. Never set `NODE_TLS_REJECT_UNAUTHORIZED`. If the client refuses plain HTTP, pass the container's certificate with `NODE_EXTRA_CA_CERTS` instead.

**IT cases** (bob connects with the real `jmapClient`):
1. `getSendIdentities()` lists bob's account and team's, and not the folder-share account (research E11).
2. `sendRouted` from team@ to alice with an attachment:
   - the copy is in team's Sent, without `$draft`;
   - nothing new is in bob's Sent or Drafts;
   - alice receives `From: team@example.org` with the attachment intact (this proves `Blob/copy` works on Stalwart).
3. `sendRouted` with bob's own team@ identity id is refused with `'identity_gone'`, and no Email is created in team's account (E4).
4. `sendRouted` with From `bob@` and team's identity is refused with `'identity_gone'` (E5).
5. A routed send with a `draftId` from bob's own Drafts destroys it in bob's account only.

- [ ] **Step 1: Write the script and the IT file.** Run the script. Expected: all cases PASS, and `docker ps -a | grep sharedsend-it` is empty afterwards. If case 2 fails on `Blob/copy`, stop and report: don't work around it.
- [ ] **Step 2: Check** that `npm test` skips the IT file (it reports as skipped, not failed).
- [ ] **Step 3: Update the docs.**
  - `CHANGES.md`: a "Shared-account sending" section in the house style, with short hashes.
  - Roadmap "Left open":
    - D5-A, offline queueing for group identities (queue row schema 3, an identity check at replay, an `identity_unavailable` hold);
    - IdentitySettings' default-sender chooser lists only your own identities (aliases cover the old team@ preference);
    - unsubscribe and read receipts always send from your own account;
    - a hidden own duplicate is only reachable by removing the group identity.
  - Parity: mark 04:74 done and update the counts.
- [ ] **Step 4: Run** the full gate, the Tokyo run and the Node 20 run. Expected: PASS.
- [ ] **Step 5: Commit:** `test: check routed sends against a throwaway Stalwart, and record shared-account sending`.

# Follow-up cleanup 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** close the last small storage items left open by Follow-up cleanup 2.

**Architecture:**
- The settings store gets four guards:
  - a corrupt non-readers row is moved aside;
  - a settings read refused on three launches in a row asks the user;
  - the settings backup is removed on reset and on sign-out of every account;
  - a hydrate that hangs is bounded.
- Push resync requires the account it is for.
- The Outbox retries a failed hydrate on foreground.

**Tech Stack:** React Native (Expo SDK 54), zustand, AsyncStorage, vitest.

**Spec:** the "Follow-up cleanup 2 (2026-10-10)" → "Left open" list in `docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md`.

## Global Constraints
- These are the house rules in `.superpowers/sdd/2026-10-10-cleanup-follow-ups-3/common.md`: stage by path, no stash, reset or checkout, TDD, app-account keying and the gate.
- Gate: `npm run typecheck && npm test && npm run i18n:check`, plus Node 20 over `src/lib` and `src/stores`.
- Never write the user's settings over a read that failed. Never delete a live account's data.
- User strings go through `t()`. RN keys go through `npm run i18n:harvest`.

## Review Focus
1. A corrupt non-readers row must never let a later-added account read the legacy colours. Moving it aside drops the old colours: the account gets a fresh colour, never a wrong one.
2. The refused-read prompt must not appear for a read that later succeeds in the same launch, and "Reset" must back up whatever can be read first. A refused read has nothing to back up, so say so in the prompt.
3. The hydrate time bound must fail closed: treat it as a refused read, so writes stay blocked and retry. A late read that lands after the timeout must still be applied.
4. Removing the settings backup on `logoutAll` and `resetToDefaults` only. Never on a single-account sign-out.
5. An Outbox retry must never send twice or load another account's queue.

---

### Task 1: Settings storage guards

**Files:** `src/stores/settings-store.ts`; `src/components/settings/AboutDataSettings.tsx` or App-level prompt host (pick the existing alert pattern); `src/stores/auth-store.ts` (`logoutAll` only, one call); tests in `src/stores/__tests__/settings-store*.test.ts`; `locales/rn/en.json`.

- [ ] **1a. Corrupt non-readers row.**
  - Where: `LEGACY_COLOR_NON_READERS_KEY`, read at about :909.
  - Corrupt JSON or a value that is not a list of strings goes to `bulwark:calendar-color-non-readers:v1:corrupt`. Then seed the readers as `[]`, which retires the legacy keys, and persist.
  - A rejected read keeps today's wait.
  - Test both.
- [ ] **1b. Refused-read cap.**
  - Count launches whose first settings read was refused in `webmail:settings:v1:refused-launches`, a number. Reset it to 0 on any successful read.
  - On the third launch in a row, show once per launch: title `t('settings.unreadable_title', 'Your settings could not be read')`, body `t('settings.unreadable_body', "Your device refused to read your saved settings three times in a row. You can keep trying, or reset them to the defaults (the old settings cannot be recovered).")`, buttons `t('settings.unreadable_keep', 'Keep trying')` and `t('settings.unreadable_reset', 'Reset settings')`.
  - "Reset settings" calls a new `forceResetUnreadableSettings()`, which clears `settingsReadFailed`, applies the defaults plus the held edits, and persists.
  - The read flow and the counter are tested. The prompt host is tested with a pure helper `shouldPromptUnreadable(count, readFailed, refused)`.
- [ ] **1c. Backup cleanup.**
  - `resetToDefaults` and `logoutAll` remove `CORRUPT_SETTINGS_KEY` and the non-readers `:corrupt` key.
  - A single-account `logout` and `removeAccount` don't.
  - In `logoutAll`, add a bounded, caught step after the credentials.
  - Test it.
- [ ] **1d. Hydrate bound.**
  - If the settings `getItem` doesn't settle within 10 s (`SETTINGS_READ_TIMEOUT_MS`), treat it as a refused read: `settingsReadFailed`, writes blocked, foreground retry.
  - If the slow read lands later, apply it through the normal `settleRead` path, unless a newer read has already settled.
  - Test with fake timers.
- [ ] **Commit** each part, or group them, with lower-case conventional messages.

### Task 2: Push resync account, and Outbox hydrate retry

**Files:** `src/lib/push-notifications.ts` (`resyncPushNotifications` params), `src/lib/push-inbox-only.ts`, `App.tsx` (resync callers), `src/stores/send-queue-store.ts` (`hydrateAccount`), the Outbox foreground hook (find the existing AppState listener, or add one in the store), tests.

- [ ] **2a.** `resyncPushNotifications` takes a **required** `forAccountId`, and every caller passes it. `setupPushNotifications` for a first setup may keep it optional. Typecheck proves every resync caller passes it.
- [ ] **2b.** When `hydrateAccount` rejects because a write-back failed, record the account as `hydrateFailed`. On AppState `active`, and before the next `flush` for that account, retry `hydrateAccount`.
  - The retry runs inside `serialize(appAccountId)`.
  - It never sends during the hydrate.
  - It only retries the account that failed.
  - Test: the first hydrate rejects, a foreground retry succeeds, the Outbox shows the rows, and one flush sends once.

### Task 3: Docs

**Files:** the roadmap, `CHANGES.md`.

- [ ] In "Follow-up cleanup 2 → Left open", mark the done items with hashes. Add a "Follow-up cleanup 3" section with what changed and Left open (the sender-check limits, the device checks, the upstream requests, shared-account sending and the blocked parity items stay).
- [ ] Add "Follow-up cleanup 3 (unmerged)" to `CHANGES.md`, and mark cleanup 2 as merged (#18).

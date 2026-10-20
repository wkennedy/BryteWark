# Smaller follow-ups: language, week view, icons, font-size restart

Date: 2026-10-20. Branch: `fix/smaller-follow-ups`. Approved in chat on 2026-10-20.

## Goal

Close four "Left open" items from the parity roadmap (Device checks 2 and Device checks 3):

1. About 90 components read only `t` and keep the old language until they re-render. Device checks 3 showed it on a cold start too: the Inbox header said "Inbox" in Arabic while the drawer was translated.
2. The week view (TimeGridScrollView) has the rows-added-above pattern the month view had.
3. Send and LogOut aren't in the directional-icon guard. Drafts and Trash icons differ between the drawer and folder settings.
4. A live system font-size change sends the app back to the Inbox.

Out of scope (the user's choice): the Follow-up cleanup 3 minors and the shared-account hotfix leftovers. They stay open in the roadmap.

There is no React render harness (vitest runs in `node`, `src/**/__tests__/**/*.test.ts` only). Screen behaviour is moved into pure helpers or stores that can be unit-tested, and the rest is checked on the S24+.

## 1. Language

### Cause

`useLocaleStore` (src/stores/locale-store.ts) creates `t` once, as `(key, fallback, params) => translate(get().locale, ...)`. Its identity never changes, so:

- a component selecting only `s => s.t` never re-renders on a language change (90 files);
- a `useMemo`/`useCallback` keyed on `t` keeps its old value even when its component re-renders (the Inbox `headerTitle` in EmailListScreen.tsx, keyed on `[currentMailbox, t]`).

On a cold start, `hydrate()` is only called from an App effect (App.tsx:507), after the first render, and returning users skip the loading screen (App.tsx:1054). So the first render uses the device language, and the saved one lands later.

### Design

**Load the language before the navigator.**
- Start `useLocaleStore.getState().hydrate()` at module load in App.tsx, as settings already does (App.tsx:121). Keep the effect call harmless (hydrate stays idempotent).
- App renders the navigator, LoginScreen or LoadingScreen only once `useLocaleStore(s => s.hydrated)` is true. Until then it renders the status bar and an empty themed view, with no text, since no language is known yet.
- The storage read in `hydrate` gets a short deadline (1 s). On timeout it falls back to the device language and marks `hydrated`, so a hung AsyncStorage can't hold the app on a blank screen. A late read that lands after the deadline is ignored for this launch (the override is applied next launch); this is stated in a comment.

**New `t` per language.**
- `hydrate` and `setOverride` set `t` to a new function bound to the new locale whenever the locale changes. Setting the same locale keeps the same `t`.
- The non-hook `t()` export keeps working unchanged (it reads `getState().t`).

**Effect audit.** Every dependency list containing `t` (65 at research time: about 28 `useCallback`, 20 `useMemo`, 6 `useEffect`) is checked:
- `useMemo` and `useCallback` re-running on a switch is the intended fix; they stay.
- A `useEffect` (directly, or through a callback in its list) that does network work, schedules timers, sends anything or navigates must not re-run on a switch. Such an effect reads `t` through a ref (`tRef.current`) and drops `t` from its list. Known ones: EmailSourceScreen.tsx:44 (fetches the raw message), EmailThreadScreen.tsx:448 (`ensureDetail`, mark-read scheduling), FilesScreen.tsx:320 (`pendingOpen`), LoginScreen.tsx:506, EmailListScreen.tsx:1200 (`pendingFolder`). ReadReceiptBanner.tsx:171 is already guarded by `autoAttempted`; it is checked, not changed unless the audit finds a gap.
- The audit's result (each effect and its verdict) goes in the plan's task notes so the reviewer can check it.

### Tests

- New `src/stores/__tests__/locale-store.test.ts`: `t` changes identity after `setOverride` to another language and after `hydrate` loads a stored override; it keeps identity when the language doesn't change; `t` translates with the new locale; `hydrate` falls back to the device language when the read exceeds the deadline.
- A source-scanning test (like `screens-i18n`) lists the audited effects and fails if one of them lists `t` in its dependencies again.

## 2. Week view

### Cause

MonthScrollView fixed this in ecc1771: when a jump also grows the window at the top, it defers the scroll until `onContentSizeChange` plus one `requestAnimationFrame`, with a 300 ms fallback (MonthScrollView.tsx:215-240, 322). TimeGridScrollView.tsx:335-346 still calls `scrollToIndex` immediately on a new `focus.nonce`.

### Design

- Port the same pattern to TimeGridScrollView: on a focus change, if the window grew at the top in the same update, store the target in a pending ref and scroll from `onContentSizeChange` (then one frame), with the 300 ms fallback; otherwise scroll at once.
- The "should this scroll wait" decision moves into a pure helper in src/lib (shared with the month view if it fits without changing its behaviour; otherwise beside it).
- The week's jump room (`JUMP_ROOM_ROWS.week = 1`) stays unless the device check shows it's needed.

### Tests

Unit tests for the helper: grew at top → wait; no growth or growth at the bottom → scroll at once. The timing itself is a device check.

## 3. Icons

### Design

- Add `Send` and `LogOut` to `ICONS` in src/components/__tests__/directional-icons.test.ts.
- Each use is then wrapped in `DirectionalIcon` or added to the test's `ALLOWED` list with a reason. Expected: LogOut flips (it's a door with an arrow pointing out); a Send paper plane flips where it reads as "forward" in RTL. Uses: SidebarDrawer.tsx:1034, 1051, 1096; QuickReplyBox.tsx:361; SettingsScreen.tsx:516; OutboxScreen.tsx:186; ComposeScreen.tsx:3034. The implementer checks each against Material's RTL guidance and records the choice in the commit.
- One shared role-to-icon module (for example src/lib/mailbox-role-icon.ts) replaces the drawer's switch (SidebarDrawer.tsx:84-99, including the name fallbacks) and FolderSettings' `ROLE_ICON` (FolderSettings.tsx:42), and any other copy found. Drafts is `File`, Trash is `Trash2` (the drawer's choice).

### Tests

- The directional-icon guard covers Send and LogOut.
- A unit test pins the map: drafts → `File`, trash → `Trash2`, and that both screens import the shared module (source scan).

## 4. Font-size restart

### Cause

AndroidManifest.xml's `configChanges` has no `fontScale`, so the activity is recreated, and MainActivity relies on that to reload font metrics. `<NavigationContainer>` (App.tsx:1073) has no `initialState`, so the remounted root starts at its first route. The JS runtime survives the recreation.

### Design

- A small module (for example src/lib/nav-state-cache.ts) keeps the last navigation state in a module variable. `onStateChange` writes it; `initialState` reads it when the container mounts.
- Before restoring, Compose routes are removed from the state (and their stack indexes fixed up). A restored composer would come back empty; its draft already autosaved.
- The cache is cleared on sign-out and on an account switch, so a new session never restores another account's screens.
- `configChanges` is not changed.

### Tests

Unit tests for the module: stores and returns state; drops Compose routes at any depth and keeps indexes valid; returns undefined after clearing. The restore itself is a device check.

## Verification

- Gates: `npm run typecheck && npm test && npm run i18n:check`, `TZ=Asia/Tokyo npm test`, and the Node 20 run of `src/lib src/stores`.
- S24+ device check (no server changes): switch language live in Settings and confirm the Inbox header and other screens change at once; cold start in Arabic; the week view jumping far back; the font-size change from a nested screen (Settings → Identities) returning to that screen; LogOut and Send icons in RTL. Font scale and language are restored afterwards.
- Docs: CHANGES.md at the top, the roadmap's "Left open" entries marked done, NEXT-SESSION.md.

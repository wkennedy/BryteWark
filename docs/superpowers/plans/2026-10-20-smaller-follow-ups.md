# Smaller follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every screen follow a language change at once (and start in the saved language), defer the week view's jump scroll like the month view's, bring Send/LogOut under the directional-icon guard with one role-icon map, and keep the user's screen across a live system font-size change.

**Architecture:** The locale store hands out a new `t` per language and loads before the navigator; effects with side effects read `t` through a ref. The week view reuses the month view's deferred-scroll pattern via a shared pure helper. A shared module maps mailbox roles to icons. A module-level navigation-state cache, keyed by account, restores the stack when Android recreates the activity.

**Tech Stack:** React Native 0.81.5 / Expo, zustand, React Navigation, lucide-react-native, vitest (node environment, no render harness).

**Spec:** `docs/superpowers/specs/2026-10-20-smaller-follow-ups-design.md`

## Global Constraints

- No render harness: logic that needs a test goes into a pure helper or store under `src/lib` / `src/stores`; screen wiring is covered by typecheck, source-scan tests and the device check.
- Tests live in `src/**/__tests__/**/*.test.ts`; run one file with `npx vitest run <path>`.
- Gate before the final review: `npm run typecheck && npm test && npm run i18n:check`, then `TZ=Asia/Tokyo npm test`, then `PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx vitest run src/lib src/stores`.
- No new user-visible strings are expected. Any that appear go through `t` with an English fallback and pass `npm run i18n:check`.
- Never run `expo prebuild --clean`; do not edit `android/` (`configChanges` stays as it is).
- Never contact the user's mail server; nothing in this plan needs a server.
- Match the surrounding code's comment style: short comments that say why.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Picking "System default" when it resolves to the language already shown must not change `t` (no needless re-render or effect re-run). Test: Task 1 `keeps t when the locale does not change`.
- A hung AsyncStorage at launch must not leave a blank screen for more than about a second. Test: Task 1 `hydrate falls back to the device locale after the deadline`.
- A late locale read arriving after the deadline must not override a language the user picked meanwhile, or flip the language mid-session. Test: Task 1 `ignores a read that lands after the deadline`.
- After a sign-out, or a switch to another account, the font-size restore must never reopen the previous session's screens. Test: Task 7 `returns nothing for another account` and `returns nothing after clear`.
- A cached state whose top route is Compose, or a nested stack that only held Compose, must restore to a valid state (indexes in range, no empty stack). Test: Task 7 `drops a top-level Compose and fixes the index` and `drops a nested stack left empty`.

---

### Task 1: Locale store hands out a new `t` per language, with a bounded hydrate

**Files:**
- Modify: `src/stores/locale-store.ts` (`hydrate`, `setOverride`, the initial `t`)
- Test: `src/stores/__tests__/locale-store.test.ts` (create)

**Interfaces:**
- Produces: `useLocaleStore` keeps its shape (`locale`, `override`, `hydrated`, `directionChangePending`, `hydrate()`, `setOverride()`, `t`). New: `t` is a fresh function whenever `locale` changes and the same function otherwise. Exported constant `LOCALE_READ_DEADLINE_MS = 1000`.

- [ ] **Step 1: Write the failing tests** (mock `@react-native-async-storage/async-storage`, `react-native`'s `I18nManager`, and `../i18n`'s `detectDeviceLocale` as the other store tests do; reset the store between tests with `useLocaleStore.setState(...)`)

```ts
it('changes t when setOverride picks another locale', () => {
  const before = useLocaleStore.getState().t;          // device locale 'en'
  useLocaleStore.getState().setOverride('ar');
  expect(useLocaleStore.getState().t).not.toBe(before);
});
it('keeps t when the locale does not change', () => {
  const before = useLocaleStore.getState().t;
  useLocaleStore.getState().setOverride(null);          // resolves to 'en' again
  expect(useLocaleStore.getState().t).toBe(before);
});
it('changes t when hydrate loads a stored override', async () => {
  storage.getItem.mockResolvedValue(JSON.stringify({ override: 'ar' }));
  const before = useLocaleStore.getState().t;
  await useLocaleStore.getState().hydrate();
  expect(useLocaleStore.getState().t).not.toBe(before);
  expect(useLocaleStore.getState().locale).toBe('ar');
});
it('translates with the new locale', () => {
  useLocaleStore.getState().setOverride('de');
  expect(useLocaleStore.getState().t('common.loading', 'Loading...')).toBe(translate('de', 'common.loading', 'Loading...'));
});
it('hydrate falls back to the device locale after the deadline', async () => {
  vi.useFakeTimers();
  storage.getItem.mockReturnValue(new Promise(() => {}));
  const done = useLocaleStore.getState().hydrate();
  await vi.advanceTimersByTimeAsync(LOCALE_READ_DEADLINE_MS);
  await done;
  expect(useLocaleStore.getState()).toMatchObject({ hydrated: true, locale: 'en', override: null });
});
it('ignores a read that lands after the deadline', async () => {
  vi.useFakeTimers();
  let resolve!: (v: string) => void;
  storage.getItem.mockReturnValue(new Promise((r) => { resolve = r; }));
  const done = useLocaleStore.getState().hydrate();
  await vi.advanceTimersByTimeAsync(LOCALE_READ_DEADLINE_MS);
  await done;
  useLocaleStore.getState().setOverride('fr');
  resolve(JSON.stringify({ override: 'ar' }));
  await vi.runAllTimersAsync();
  expect(useLocaleStore.getState().locale).toBe('fr');
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/stores/__tests__/locale-store.test.ts`
Expected: the identity, deadline and late-read tests FAIL; `keeps t…` and `translates…` may already pass.

- [ ] **Step 3: Implement in `src/stores/locale-store.ts`**

- A private `tFor(locale: LocaleCode): TranslateFn` returning `(key, fallback, params) => translate(locale, key, fallback, params)`. The initial state uses `tFor(detectDeviceLocale())`.
- `setOverride` and `hydrate` set `t: tFor(locale)` only when `locale !== get().locale`.
- `hydrate` races the `AsyncStorage.getItem` against `LOCALE_READ_DEADLINE_MS`. On timeout it sets `hydrated: true` with the device locale and returns; the losing read is dropped (a comment says the stored override applies from the next launch). Keep the existing `catch` behaviour.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run src/stores/__tests__/locale-store.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/stores/locale-store.ts src/stores/__tests__/locale-store.test.ts
git commit -m "fix: a language change gives t a new identity, so every screen follows it"
```

### Task 2: Load the language before any screen renders

**Files:**
- Modify: `App.tsx` (module-level start near line 121; the render gates near lines 1050-1073; the effect at line 507)

**Interfaces:**
- Consumes: `useLocaleStore` `hydrated` and `hydrate()` from Task 1.

- [ ] **Step 1: Start the read at module load.** Next to `void useSettingsStore.getState().hydrate();` (App.tsx:121) add `void useLocaleStore.getState().hydrate();`. Leave the call in the effect at line 507 (it returns early once hydrated).

- [ ] **Step 2: Gate rendering.** In the App component select `const localeHydrated = useLocaleStore((s) => s.hydrated);`. Before the existing `LoadingScreen` / `LoginScreen` / `NavigationContainer` returns, when `!localeHydrated` return the `<StatusBar style={statusBarStyle} />` plus a full-screen `View` with the theme's background colour and no text. Comment: no language is known yet, so nothing is written. Put the early return after every hook in App (rules of hooks), next to the existing ones.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx vitest run src/stores`
Expected: no type errors; store tests PASS.

- [ ] **Step 4: Commit**

```bash
git add App.tsx
git commit -m "fix: the app starts in the saved language instead of switching to it after the first screen"
```

### Task 3: Effect audit, so a language switch never re-runs side effects

**Files:**
- Modify: each file whose `useEffect` lists `t` (directly or through a `useCallback` that lists `t`) and does network work, schedules timers, sends or navigates. Known: `src/screens/EmailSourceScreen.tsx:44`, `src/screens/EmailThreadScreen.tsx:448`, `src/screens/FilesScreen.tsx:320`, `src/screens/LoginScreen.tsx:506`, `src/screens/EmailListScreen.tsx:1200`. Check, and change only if needed: `src/components/email/ReadReceiptBanner.tsx:171`.
- Create: `src/lib/use-latest-ref.ts`
- Test: `src/screens/__tests__/effects-ignore-locale.test.ts` (create; follow `screens-i18n.test.ts` for reading sources)

**Interfaces:**
- Produces: `useLatestRef<T>(value: T): React.MutableRefObject<T>` (assigns `ref.current = value` on every render). If an equivalent hook already exists in `src/lib`, use that instead and skip creating one.

- [ ] **Step 1: Audit.** List every dependency array containing `t` (`grep -rn "\bt\b[],]" src App.tsx` filtered to dependency arrays, about 65). For each `useEffect` (and each `useCallback` an effect depends on) decide "re-run is harmless" or "must not re-run". Record the table (file:line, kind, verdict, one-line reason) in `.superpowers/sdd/2026-10-20-smaller-follow-ups/audit.md` for the reviewer.

- [ ] **Step 2: Write the failing guard test.** `effects-ignore-locale.test.ts` holds a list `GUARDED: Array<[file, marker]>` with one entry per "must not re-run" effect, where `marker` is a unique substring inside that effect's body (for example `'ensureDetail('`). For each entry it finds the `useEffect(` call enclosing the marker and asserts its dependency array does not contain the identifier `t`. Use the TypeScript compiler API, as `chrome-font-cap.test.ts` does.

```ts
it('keeps t out of effects that fetch, send, schedule or navigate', () => {
  expect(offenders(GUARDED)).toEqual([]);
});
it('flags an effect that lists t', () => {
  expect(offenders([['x.tsx', 'fetchIt(']], { 'x.tsx': 'useEffect(() => { fetchIt(t("a")); }, [id, t]);' })).toEqual(['x.tsx fetchIt(']);
});
```

- [ ] **Step 3: Run to see it fail**

Run: `npx vitest run src/screens/__tests__/effects-ignore-locale.test.ts`
Expected: FAIL listing the known effects.

- [ ] **Step 4: Fix each flagged effect.** Read `t` (or the `t`-dependent callback) through `useLatestRef` inside the effect and remove it from the dependency array. Add a one-line comment at the first such site per file: a language switch must not refetch / resend.

- [ ] **Step 5: Confirm the Inbox header.** `headerTitle` in EmailListScreen.tsx (lines 1093-1102) now recomputes because `t` changes; no edit unless the audit shows otherwise.

- [ ] **Step 6: Run to see it pass, then typecheck**

Run: `npx vitest run src/screens/__tests__/effects-ignore-locale.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/use-latest-ref.ts src/screens src/components App.tsx
git commit -m "fix: a language switch redraws screens without refetching or resending"
```

### Task 4: The week view waits for rows added above before scrolling

**Files:**
- Modify: `src/lib/calendar-scroll-window.ts` (add the helper), `src/components/calendar/MonthScrollView.tsx:224-225` (use it), `src/components/calendar/TimeGridScrollView.tsx:335-346` and its FlatList's `onContentSizeChange`
- Test: `src/lib/__tests__/calendar-scroll-window.test.ts`

**Interfaces:**
- Produces: `windowGrewAtTop(previousStart: number, nextStart: number): boolean` (true when `nextStart < previousStart`), exported from `calendar-scroll-window.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('windowGrewAtTop', () => {
  it('is true when the window starts earlier', () => { expect(windowGrewAtTop(1000, 500)).toBe(true); });
  it('is false when the start is unchanged', () => { expect(windowGrewAtTop(1000, 1000)).toBe(false); });
  it('is false when the window grew at the bottom or moved later', () => { expect(windowGrewAtTop(1000, 1500)).toBe(false); });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/lib/__tests__/calendar-scroll-window.test.ts`
Expected: FAIL, `windowGrewAtTop` is not exported.

- [ ] **Step 3: Implement.** Add the helper. In MonthScrollView replace the inline comparison with it (no behaviour change). In TimeGridScrollView port the month view's pattern: `windowStartRef`, `pendingScrollRef`, `flushPendingScroll` (clear the timer, then `requestAnimationFrame` the scroll), unmount cleanup, `PENDING_SCROLL_FALLBACK_MS` (import or share the month view's 300 ms constant; don't define a second value), and call `flushPendingScroll` from the FlatList's `onContentSizeChange` (chain any existing handler). Move the `scrollToIndex` call into a `scrollToFocusRef` so the deferred path uses the latest target. Keep the copied comment short and point to MonthScrollView for the reason.

- [ ] **Step 4: Run to see them pass, then typecheck**

Run: `npx vitest run src/lib/__tests__/calendar-scroll-window.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-scroll-window.ts src/lib/__tests__/calendar-scroll-window.test.ts src/components/calendar/MonthScrollView.tsx src/components/calendar/TimeGridScrollView.tsx
git commit -m "fix: the week view waits for weeks added above before it scrolls to a jump"
```

### Task 5: Send and LogOut under the directional-icon guard

**Files:**
- Modify: `src/components/__tests__/directional-icons.test.ts:11` (`ICONS`) and `ALLOWED` if needed
- Modify: the uses the guard then flags. Known: `src/components/SidebarDrawer.tsx` (LogOut at 1034 and 1051, Send at 1096), `src/components/email/QuickReplyBox.tsx:361`, `src/screens/SettingsScreen.tsx:516`, `src/screens/OutboxScreen.tsx:186`, `src/screens/ComposeScreen.tsx:3034`

- [ ] **Step 1: Add `'Send'` and `'LogOut'` to `ICONS`.**

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/components/__tests__/directional-icons.test.ts`
Expected: FAIL listing the bare uses above.

- [ ] **Step 3: Wrap each flagged use in `<DirectionalIcon>`.** Both icons mirror in RTL (Material lists send and exit/logout among icons that mirror). Role icons drawn through a variable (the Sent folder's `Send` in the drawer and folder settings) are not JSX `<Send` and stay as drawn: they label a folder, not an action.

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/components/__tests__/directional-icons.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A src/components src/screens
git commit -m "fix: send and sign-out icons mirror in right-to-left layouts"
```

### Task 6: One role-to-icon map for the drawer and folder settings

**Files:**
- Create: `src/lib/mailbox-role-icon.ts`
- Modify: `src/components/SidebarDrawer.tsx:79-110` (the role/name switch), `src/components/settings/FolderSettings.tsx:41-55` (`ROLE_ICON`, `getIcon`), and any other role→icon copy found with `grep -rn "drafts: \|case 'drafts'" src`
- Test: `src/lib/__tests__/mailbox-role-icon.test.ts`

**Interfaces:**
- Produces: `roleIcon(role: string | null | undefined): LucideIcon | undefined` (the role table) and `mailboxIcon(role: string | null | undefined, name: string | undefined, hasChildren: boolean, isExpanded: boolean): LucideIcon` (the drawer's current behaviour: role, then name fallbacks, then `FolderOpen`/`Folder`). Drafts → `File`, Trash → `Trash2`.

- [ ] **Step 1: Write the failing tests**

```ts
it('uses File for drafts and Trash2 for trash', () => {
  expect(roleIcon('drafts')).toBe(File);
  expect(roleIcon('trash')).toBe(Trash2);
});
it('falls back on the folder name, then to a folder', () => {
  expect(mailboxIcon(null, 'Deleted Items', false, false)).toBe(Trash2);
  expect(mailboxIcon(null, 'Projects', true, true)).toBe(FolderOpen);
  expect(mailboxIcon(null, 'Projects', false, false)).toBe(Folder);
});
it('is the only role map in the drawer and folder settings', () => {
  for (const f of ['src/components/SidebarDrawer.tsx', 'src/components/settings/FolderSettings.tsx']) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    expect(text).toContain('mailbox-role-icon');
    expect(text).not.toMatch(/drafts:\s*File|case 'drafts'/);
  }
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/lib/__tests__/mailbox-role-icon.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module and switch both callers to it.** FolderSettings' `getIcon` becomes `roleIcon(mb.role) ?? Folder`. Remove now-unused icon imports.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run src/lib/__tests__/mailbox-role-icon.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox-role-icon.ts src/lib/__tests__/mailbox-role-icon.test.ts src/components/SidebarDrawer.tsx src/components/settings/FolderSettings.tsx
git commit -m "fix: drafts and trash use the same icons in the drawer and folder settings"
```

### Task 7: Keep the screen across a live font-size change

**Files:**
- Create: `src/lib/nav-state-cache.ts`
- Modify: `App.tsx:1073` (`NavigationContainer`), and the place App reacts to `isAuthenticated` becoming false
- Test: `src/lib/__tests__/nav-state-cache.test.ts`

**Interfaces:**
- Produces:
  - `rememberNavState(accountId: string | null, state: NavigationState | undefined): void`
  - `restoredNavState(accountId: string | null): NavigationState | undefined`: the cached state for that account with Compose routes removed, or undefined.
  - `clearNavState(): void`
  - `withoutRoute(state: NavigationState, name: string): NavigationState | undefined`: removes every route called `name` at any depth, keeps `index` in range, removes a nested state left with no routes (its parent route keeps no `state`), and returns undefined when the root is left empty.
- `NavigationState` from `@react-navigation/native`.

- [ ] **Step 1: Write the failing tests**

```ts
const tabs = { index: 0, routes: [{ key: 'm', name: 'Mail' }] };
const root = (routes: any[], index = routes.length - 1) => ({ key: 'r', index, routeNames: [], routes, type: 'stack', stale: false }) as any;

it('returns the state for the same account', () => {
  const s = root([{ key: 'a', name: 'MainTabs', state: tabs }, { key: 'b', name: 'Identities' }]);
  rememberNavState('acc1', s);
  expect(restoredNavState('acc1')).toEqual(s);
});
it('returns nothing for another account', () => {
  rememberNavState('acc1', root([{ key: 'a', name: 'MainTabs' }]));
  expect(restoredNavState('acc2')).toBeUndefined();
});
it('returns nothing after clear', () => {
  rememberNavState('acc1', root([{ key: 'a', name: 'MainTabs' }]));
  clearNavState();
  expect(restoredNavState('acc1')).toBeUndefined();
});
it('drops a top-level Compose and fixes the index', () => {
  const out = withoutRoute(root([{ key: 'a', name: 'MainTabs' }, { key: 'c', name: 'Compose' }], 1), 'Compose');
  expect(out?.routes.map((r) => r.name)).toEqual(['MainTabs']);
  expect(out?.index).toBe(0);
});
it('drops a nested stack left empty', () => {
  const nested = { key: 'n', index: 0, routes: [{ key: 'c', name: 'Compose' }] };
  const out = withoutRoute(root([{ key: 'a', name: 'MainTabs' }, { key: 'x', name: 'Holder', state: nested }]), 'Compose');
  expect(out?.routes.find((r) => r.name === 'Holder')?.state).toBeUndefined();
});
it('returns undefined when only Compose was open', () => {
  expect(withoutRoute(root([{ key: 'c', name: 'Compose' }]), 'Compose')).toBeUndefined();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/lib/__tests__/nav-state-cache.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module.** One module variable `{ accountId, state } | null`. A comment says why a module variable is enough: Android recreates the activity on a font-size change, but the JS runtime and this module survive.

- [ ] **Step 4: Wire App.tsx.** `NavigationContainer` gets `initialState={restoredNavState(activeAccountId)}` (read once per mount, e.g. with `useState(() => …)`) and `onStateChange={(s) => rememberNavState(activeAccountId, s)}` (chain an existing `onStateChange` if there is one). Call `clearNavState()` where App handles `isAuthenticated` turning false.

- [ ] **Step 5: Run to see them pass, then typecheck**

Run: `npx vitest run src/lib/__tests__/nav-state-cache.test.ts && npm run typecheck`
Expected: PASS (6 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/nav-state-cache.ts src/lib/__tests__/nav-state-cache.test.ts App.tsx
git commit -m "fix: a system font size change keeps the screen you were on"
```

### Task 8: Gates, device check and docs (done by the controller, not a subagent)

- [ ] **Step 1: Run the full gate** (the three commands in Global Constraints). Expected: all pass.
- [ ] **Step 2: Build the phone APK** (`cd android && ./gradlew assembleRelease -PallowDebugSignedRelease=true -PreactNativeArchitectures=arm64-v8a`), install with `adb install -r`, and check on the S24+: a live language switch in Settings changes the Inbox header and the tab labels at once; a cold start in Arabic shows Arabic from the first screen; the week view jumping well back lands on the right week; a font-size change on Settings → Identities stays there; LogOut and Send mirror in RTL; Drafts and Trash look the same in the drawer and folder settings. Restore font scale 1.0 and "System default" afterwards.
- [ ] **Step 3: Docs.** CHANGES.md entry at the top; in the roadmap, mark the Device checks 2 items (stale `t`, week view, Send/LogOut guard, Drafts/Trash icons, font-size restart) and the Device checks 3 header item done, with commit hashes; update NEXT-SESSION.md. Delete `.superpowers/sdd/2026-10-20-smaller-follow-ups/`.
- [ ] **Step 4: Commit and push** the branch, then give the compare URL.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../api/identity', () => ({ getIdentities: vi.fn(async () => []) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import {
  useSettingsStore,
  discardSettingsEditsForTests,
  shouldPromptUnreadable,
  removeSettingsBackups,
  SETTINGS_READ_TIMEOUT_MS,
  CORRUPT_SETTINGS_KEY,
} from '../settings-store';
import { readsLegacyCalendarColors } from '../../lib/calendar-color-keys';

const KEY = 'webmail:settings:v1';
const NON_READERS = 'bulwark:calendar-color-non-readers:v1';
const NON_READERS_CORRUPT = 'bulwark:calendar-color-non-readers:v1:corrupt';
const REFUSED = 'webmail:settings:v1:refused-launches';
const get = () => useSettingsStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const foreground: ((state: string) => void)[] = [];
vi.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (state: string) => void) => {
  foreground.push(fn);
  return { remove: () => undefined };
}) as never);

const realGetItem = vi.mocked(AsyncStorage.getItem).getMockImplementation()!;
const realSetItem = vi.mocked(AsyncStorage.setItem).getMockImplementation()!;

// A legacy key (two parts) and an account's own key (three parts).
const COLORS = { 'team|c1': '#111111', 'A|team|c2': '#222222' };
const STORED = JSON.stringify({ theme: 'dark', sharedCalendarColors: COLORS });

// What each read of a key does: refuse it, hang until resolved, or read it.
type Mode = 'read' | 'refuse' | 'hang';
let modes: Record<string, Mode> = {};
let hung: { key: string; resolve: (v: string | null) => void }[] = [];

function startLaunch(): void {
  useSettingsStore.setState({
    hydrated: false,
    settingsReadFailed: false,
    legacyCalendarColorNonReaders: [],
    legacyCalendarColorNonReadersReadFailed: false,
  });
}

async function launch(): Promise<void> {
  startLaunch();
  await get().hydrate();
  await flush();
  await flush();
}

describe('settings storage guards', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    modes = {};
    hung = [];
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => {
      const mode = modes[key] ?? 'read';
      if (mode === 'refuse') throw new Error('CursorWindow');
      if (mode === 'hang') return new Promise<string | null>((resolve) => { hung.push({ key, resolve }); });
      return realGetItem(key);
    });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    discardSettingsEditsForTests();
    useSettingsStore.setState({ settingsReadFailed: false, hydrated: true });
    get().resetToDefaults();
    await flush();
    await AsyncStorage.clear();
  });
  afterEach(async () => {
    vi.useRealTimers();
    // A read still out would hold the next test's read.
    for (const h of hung) h.resolve(null);
    await flush();
    await flush();
    warn.mockRestore();
    vi.mocked(AsyncStorage.getItem).mockImplementation(realGetItem);
    vi.mocked(AsyncStorage.setItem).mockImplementation(realSetItem);
  });

  describe('a non-readers row that can never be read', () => {
    it.each([['corrupt JSON', '{corrupt'], ['a list that is not of ids', '[1,2]'], ['not a list', '"A"']])(
      'is kept aside as %s, and nobody reads the old colours', async (_, raw) => {
        await AsyncStorage.setItem(KEY, STORED);
        await AsyncStorage.setItem(NON_READERS, raw);
        await launch();
        expect(await AsyncStorage.getItem(NON_READERS_CORRUPT)).toBe(raw);
        expect(get().legacyCalendarColorReaders).toEqual([]);
        expect(get().sharedCalendarColors).toEqual({ 'A|team|c2': '#222222' });
        const written = JSON.parse((await AsyncStorage.getItem(KEY))!);
        expect(written.legacyCalendarColorReaders).toEqual([]);
        expect(written.sharedCalendarColors).toEqual({ 'A|team|c2': '#222222' });
        expect(written.theme).toBe('dark');
        // An account added later (one the lost row may have named) gets a
        // fresh colour, never an old one.
        get().seedLegacyCalendarColorReaders(['A', 'C']);
        expect(get().legacyCalendarColorReaders).toEqual([]);
        expect(readsLegacyCalendarColors(get().legacyCalendarColorReaders, 'C', get().legacyCalendarColorNonReaders)).toBe(false);
      },
    );

    it('is not written over by a sign-in before the seed is stored', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      await AsyncStorage.setItem(NON_READERS, '{corrupt');
      modes[KEY] = 'refuse';
      await launch();
      expect(get().settingsReadFailed).toBe(true);
      await get().noteSignedInWhileColorReadersUnseeded('C');
      expect(await realGetItem(NON_READERS)).toBe('{corrupt');
      expect(await realGetItem(KEY)).toBe(STORED);
      // Once the settings read, the seed lands on the stored row.
      delete modes[KEY];
      for (const fn of foreground) fn('active');
      await flush();
      await flush();
      expect(get().settingsReadFailed).toBe(false);
      const written = JSON.parse((await AsyncStorage.getItem(KEY))!);
      expect(written.theme).toBe('dark');
      expect(written.legacyCalendarColorReaders).toEqual([]);
      expect(written.sharedCalendarColors).toEqual({ 'A|team|c2': '#222222' });
    });

    it('waits, as for a refused read, while the copy cannot be written', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      await AsyncStorage.setItem(NON_READERS, '{corrupt');
      vi.mocked(AsyncStorage.setItem).mockImplementation(async (key: string, value: string) => {
        if (key === NON_READERS_CORRUPT) throw new Error('disk full');
        return realSetItem(key, value);
      });
      await launch();
      expect(get().legacyCalendarColorNonReadersReadFailed).toBe(true);
      expect(get().legacyCalendarColorReaders).toBeNull();
      expect(get().sharedCalendarColors).toEqual(COLORS);
      get().seedLegacyCalendarColorReaders(['A']);
      expect(get().legacyCalendarColorReaders).toBeNull();
    });

    it('a refused read of that row keeps the wait, and copies nothing', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      await AsyncStorage.setItem(NON_READERS, JSON.stringify(['C']));
      modes[NON_READERS] = 'refuse';
      await launch();
      expect(get().legacyCalendarColorNonReadersReadFailed).toBe(true);
      expect(get().legacyCalendarColorReaders).toBeNull();
      expect(await AsyncStorage.getItem(NON_READERS_CORRUPT)).toBeNull();
      get().seedLegacyCalendarColorReaders(['A', 'C']);
      expect(get().legacyCalendarColorReaders).toBeNull();
      expect(get().sharedCalendarColors).toEqual(COLORS);
    });
  });

  describe('launches whose settings read was refused', () => {
    it('are counted, and the count goes back to 0 on a read that works', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      modes[KEY] = 'refuse';
      await launch();
      expect(await realGetItem(REFUSED)).toBe('1');
      await launch();
      await launch();
      expect(await realGetItem(REFUSED)).toBe('3');
      expect(get().settingsRefusedLaunches).toBe(3);
      expect(get().settingsReadRefused).toBe(true);
      // The read works on a retry in the same launch.
      delete modes[KEY];
      for (const fn of foreground) fn('active');
      await flush();
      await flush();
      expect(get().settingsReadFailed).toBe(false);
      expect(await realGetItem(REFUSED)).toBe('0');
      expect(get().settingsRefusedLaunches).toBe(0);
    });

    it('a launch that reads them resets the count', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      await AsyncStorage.setItem(REFUSED, '2');
      await launch();
      expect(await realGetItem(REFUSED)).toBe('0');
    });

    it('a launch with a corrupt row it keeps aside is a read that works', async () => {
      await AsyncStorage.setItem(KEY, '{corrupt');
      await AsyncStorage.setItem(REFUSED, '2');
      await launch();
      expect(await realGetItem(REFUSED)).toBe('0');
    });

    it('a stored count that is not a number counts from 0', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      await AsyncStorage.setItem(REFUSED, 'x');
      modes[KEY] = 'refuse';
      await launch();
      expect(await realGetItem(REFUSED)).toBe('1');
    });

    it('prompt only from the third refused launch on, while still refused', () => {
      expect(shouldPromptUnreadable(2, true, true)).toBe(false);
      expect(shouldPromptUnreadable(3, true, true)).toBe(true);
      expect(shouldPromptUnreadable(4, true, true)).toBe(true);
      // Read since, in this launch.
      expect(shouldPromptUnreadable(3, false, true)).toBe(false);
      // A corrupt row whose copy could not be written: a reset would lose it.
      expect(shouldPromptUnreadable(3, true, false)).toBe(false);
    });
  });

  describe('forceResetUnreadableSettings', () => {
    it('writes the defaults with the edits made meanwhile', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      modes[KEY] = 'refuse';
      await launch();
      get().addTrustedSender('bob@example.com');
      await flush();
      expect(await realGetItem(KEY)).toBe(STORED);
      await get().forceResetUnreadableSettings();
      await flush();
      expect(get().settingsReadFailed).toBe(false);
      expect(get().theme).toBe('system');
      expect(get().trustedSenders).toEqual(['bob@example.com']);
      const written = JSON.parse((await realGetItem(KEY))!);
      expect(written.theme).toBe('system');
      expect(written.trustedSenders).toEqual(['bob@example.com']);
      get().updateSetting('fontSize', 'large');
      await flush();
      expect(JSON.parse((await realGetItem(KEY))!).fontSize).toBe('large');
    });

    it('keeps the stored settings when they read on that last try', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      modes[KEY] = 'refuse';
      await launch();
      delete modes[KEY];
      await get().forceResetUnreadableSettings();
      await flush();
      expect(get().settingsReadFailed).toBe(false);
      expect(get().theme).toBe('dark');
      expect(JSON.parse((await realGetItem(KEY))!).theme).toBe('dark');
    });

    it('keeps a row that reads but is corrupt aside before the defaults go over it', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      modes[KEY] = 'refuse';
      await launch();
      delete modes[KEY];
      await AsyncStorage.setItem(KEY, '{corrupt');
      await get().forceResetUnreadableSettings();
      await flush();
      expect(await realGetItem(CORRUPT_SETTINGS_KEY)).toBe('{corrupt');
      expect(get().settingsReadFailed).toBe(false);
    });

    it('does nothing after a read that worked', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      await launch();
      await get().forceResetUnreadableSettings();
      await flush();
      expect(get().theme).toBe('dark');
      expect(await realGetItem(KEY)).toBe(STORED);
    });
  });

  describe('the settings backups', () => {
    it('resetToDefaults removes both', async () => {
      await AsyncStorage.setItem(CORRUPT_SETTINGS_KEY, '{a');
      await AsyncStorage.setItem(NON_READERS_CORRUPT, '{b');
      get().resetToDefaults();
      await flush();
      expect(await AsyncStorage.getItem(CORRUPT_SETTINGS_KEY)).toBeNull();
      expect(await AsyncStorage.getItem(NON_READERS_CORRUPT)).toBeNull();
    });

    it('removeSettingsBackups removes both, and nothing else', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      await AsyncStorage.setItem(CORRUPT_SETTINGS_KEY, '{a');
      await AsyncStorage.setItem(NON_READERS_CORRUPT, '{b');
      await removeSettingsBackups();
      expect(await AsyncStorage.getItem(CORRUPT_SETTINGS_KEY)).toBeNull();
      expect(await AsyncStorage.getItem(NON_READERS_CORRUPT)).toBeNull();
      expect(await AsyncStorage.getItem(KEY)).toBe(STORED);
    });
  });

  describe('a settings read that does not settle', () => {
    it('is a refused read after the time bound, and applied when it lands', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      modes[KEY] = 'hang';
      vi.useFakeTimers();
      startLaunch();
      const done = get().hydrate();
      await vi.advanceTimersByTimeAsync(SETTINGS_READ_TIMEOUT_MS - 1);
      expect(get().hydrated).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(get().hydrated).toBe(true);
      expect(get().settingsReadFailed).toBe(true);
      expect(get().settingsReadRefused).toBe(true);
      expect(foreground.length).toBeGreaterThan(0);
      // Writes stay blocked.
      get().updateSetting('fontSize', 'large');
      await vi.advanceTimersByTimeAsync(0);
      expect(await realGetItem(KEY)).toBe(STORED);
      // The first read lands.
      hung[0].resolve(STORED);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(get().settingsReadFailed).toBe(false);
      expect(get().theme).toBe('dark');
      expect(get().fontSize).toBe('large');
      const written = JSON.parse((await realGetItem(KEY))!);
      expect(written.theme).toBe('dark');
      expect(written.fontSize).toBe('large');
    });

    it('is not applied when a newer read settled first', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      modes[KEY] = 'hang';
      vi.useFakeTimers();
      startLaunch();
      const done = get().hydrate();
      await vi.advanceTimersByTimeAsync(SETTINGS_READ_TIMEOUT_MS);
      await done;
      expect(get().settingsReadFailed).toBe(true);
      // A retry reads them, and a change is written.
      delete modes[KEY];
      for (const fn of foreground) fn('active');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(get().settingsReadFailed).toBe(false);
      get().updateSetting('theme', 'light');
      await vi.advanceTimersByTimeAsync(0);
      // The first read lands late, with what it read back then.
      hung[0].resolve(STORED);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(get().theme).toBe('light');
      expect(JSON.parse((await realGetItem(KEY))!).theme).toBe('light');
    });

    it('a read that settles in time clears its timer', async () => {
      await AsyncStorage.setItem(KEY, STORED);
      vi.useFakeTimers();
      startLaunch();
      await get().hydrate();
      expect(get().settingsReadFailed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

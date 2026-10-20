import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false, allowRTL: vi.fn(), forceRTL: vi.fn() },
}));
vi.mock('../../i18n', async () => ({
  ...(await vi.importActual<typeof import('../../i18n')>('../../i18n')),
  detectDeviceLocale: () => 'en',
}));

import { translate } from '../../i18n';
import { LOCALE_READ_DEADLINE_MS, useLocaleStore } from '../locale-store';

const storage = AsyncStorage as unknown as {
  getItem: ReturnType<typeof vi.fn>;
};

describe('locale store', () => {
  beforeEach(() => {
    storage.getItem.mockReset();
    useLocaleStore.setState({
      locale: 'en',
      override: null,
      hydrated: false,
      directionChangePending: false,
      t: (key, fallback, params) => translate('en', key, fallback, params),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('changes t when setOverride picks another locale', () => {
    const before = useLocaleStore.getState().t;
    useLocaleStore.getState().setOverride('ar');
    expect(useLocaleStore.getState().t).not.toBe(before);
  });

  it('keeps t when the locale does not change', () => {
    const before = useLocaleStore.getState().t;
    useLocaleStore.getState().setOverride(null);
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
    expect(useLocaleStore.getState().t('common.loading', 'Loading...')).toBe(
      translate('de', 'common.loading', 'Loading...'),
    );
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
    const second = useLocaleStore.getState().hydrate();
    await vi.advanceTimersByTimeAsync(LOCALE_READ_DEADLINE_MS);
    await Promise.all([done, second]);
    resolve(JSON.stringify({ override: 'ar' }));
    await vi.runAllTimersAsync();
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(useLocaleStore.getState()).toMatchObject({ locale: 'en', override: null, hydrated: true });
  });

  it('two concurrent hydrate calls read storage once', async () => {
    let resolve!: (v: string) => void;
    storage.getItem.mockReturnValue(new Promise((r) => { resolve = r; }));
    const first = useLocaleStore.getState().hydrate();
    const second = useLocaleStore.getState().hydrate();
    resolve(JSON.stringify({ override: 'ar' }));
    await Promise.all([first, second]);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(useLocaleStore.getState()).toMatchObject({ hydrated: true, locale: 'ar', override: 'ar' });
  });
});

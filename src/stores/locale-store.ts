import { create } from 'zustand';
import { I18nManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  detectDeviceLocale,
  getLocaleDirection,
  isSupportedLocale,
  translate,
  type LocaleCode,
  type MessageParams,
} from '../i18n';

const STORAGE_KEY = 'webmail:locale:v1';

// Startup waits on hydrate, so a stuck storage read must not hold it forever.
export const LOCALE_READ_DEADLINE_MS = 1000;

const TIMED_OUT = Symbol('locale-read-timed-out');

// App calls hydrate at module load and again on mount; the second call must
// share the first read (and its deadline) instead of starting its own.
let inflight: Promise<void> | null = null;

export type TranslateFn = (key: string, fallback?: string, params?: MessageParams) => string;

interface LocaleState {
  locale: LocaleCode;
  override: LocaleCode | null;
  hydrated: boolean;
  /**
   * True when the layout direction the current locale needs differs from
   * what the running app was laid out with. RN only applies forceRTL on the
   * next launch, so the language pane shows a "restart to apply" hint.
   */
  directionChangePending: boolean;
  hydrate: () => Promise<void>;
  setOverride: (locale: LocaleCode | null) => void;
  t: TranslateFn;
}

/**
 * Ask RN to mirror layouts for RTL locales (ar/he/fa). The device locale is
 * handled by the OS (`android:supportsRtl`), but an in-app override needs an
 * explicit forceRTL, which only takes effect after a restart. Returns true
 * when the running layout does not match the requested direction yet.
 */
function applyLayoutDirection(locale: LocaleCode): boolean {
  const rtl = getLocaleDirection(locale) === 'rtl';
  const manager = I18nManager as typeof I18nManager | undefined;
  if (!manager || typeof manager.forceRTL !== 'function') return false;
  try {
    manager.allowRTL(rtl);
    manager.forceRTL(rtl);
  } catch {
    return false;
  }
  return manager.isRTL !== rtl;
}

// A new function per locale lets components that select `s.t` re-render on a
// language switch.
function tFor(locale: LocaleCode): TranslateFn {
  return (key, fallback, params) => translate(locale, key, fallback, params);
}

export const useLocaleStore = create<LocaleState>((set, get) => ({
  locale: detectDeviceLocale(),
  t: tFor(detectDeviceLocale()),
  override: null,
  hydrated: false,
  directionChangePending: false,

  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    inflight ??= (async () => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), LOCALE_READ_DEADLINE_MS);
        });
        const raw = await Promise.race([AsyncStorage.getItem(STORAGE_KEY), deadline]).finally(() =>
          clearTimeout(timer),
        );
        if (raw === TIMED_OUT) {
          // The late read is dropped; the stored override applies from the next launch.
          // No applyLayoutDirection here: it would flip the next launch's layout, so a
          // timed-out launch can show device-language text in last launch's direction.
          set({ hydrated: true });
          return;
        }
        const stored = raw ? (JSON.parse(raw).override as string | null) : null;
        const override = stored && isSupportedLocale(stored) ? stored : null;
        const locale = override ?? detectDeviceLocale();
        const directionChangePending = applyLayoutDirection(locale);
        set({
          override,
          locale,
          hydrated: true,
          directionChangePending,
          ...(locale !== get().locale && { t: tFor(locale) }),
        });
      } catch {
        set({ hydrated: true });
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  },

  setOverride: (override) => {
    const locale = override ?? detectDeviceLocale();
    const directionChangePending = applyLayoutDirection(locale);
    set({
      override,
      locale,
      directionChangePending,
      ...(locale !== get().locale && { t: tFor(locale) }),
    });
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ override })).catch(() => {});
  },
}));

// Non-hook accessor for code outside React (background tasks, stores).
export function t(key: string, fallback?: string, params?: MessageParams): string {
  return useLocaleStore.getState().t(key, fallback, params);
}

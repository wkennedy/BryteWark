// A just-enough hook runtime so a function component can be run in the node
// test environment (the repo has no renderer): state/ref/memo slots by call
// order, effects ignored. `renderComponent` returns the latest element tree
// and re-renders it after each state change.
import * as React from 'react';
import type { ReactElement } from 'react';

interface Slot { value: unknown }
let slots: Slot[] = [];
let cursor = 0;
let runEffects = false;
let pendingEffects: Array<() => unknown> = [];
let rerender: (() => void) | null = null;

function slot<T>(init: () => T): Slot {
  const s = slots[cursor] ?? (slots[cursor] = { value: init() });
  cursor++;
  return s;
}

export const hookShim = {
  useState: <T,>(init: T | (() => T)) => {
    const s = slot(() => (typeof init === 'function' ? (init as () => T)() : init));
    return [s.value as T, (v: T | ((p: T) => T)) => {
      s.value = typeof v === 'function' ? (v as (p: T) => T)(s.value as T) : v;
      rerender?.();
    }] as const;
  },
  useRef: <T,>(init: T) => slot(() => ({ current: init })).value as { current: T },
  useMemo: <T,>(fn: () => T) => slot(fn).value as T,
  useCallback: <T,>(fn: T) => fn,
  useEffect: (fn: () => unknown) => {
    const s = slot(() => ({ ran: false }));
    const state = s.value as { ran: boolean };
    if (runEffects && !state.ran) { state.ran = true; pendingEffects.push(fn); }
  },
  useLayoutEffect: () => undefined,
  useDebugValue: () => undefined,
  useSyncExternalStore: <T,>(_sub: unknown, get: () => T) => get(),
};

// React's hooks dispatch through this internal slot; filling it lets the real
// react (and zustand's hooks on top of it) run outside a renderer.
const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** `effects`: run each effect once, after the first render (off: ignored). */
export function renderComponent<P>(Comp: (props: P) => ReactElement | null, props: P, opts: { effects?: boolean } = {}) {
  runEffects = !!opts.effects;
  pendingEffects = [];
  slots = [];
  internals.H = hookShim;
  let tree: ReactElement | null = null;
  const run = () => { cursor = 0; tree = Comp(props); };
  rerender = run;
  run();
  for (const fn of pendingEffects.splice(0)) fn();
  return { tree: () => tree };
}

/** First element in `node` for which `match` holds, searching children. */
export function findElement(node: unknown, match: (props: Record<string, any>) => boolean): ReactElement<any> | null {
  if (Array.isArray(node)) {
    for (const n of node) { const f = findElement(n, match); if (f) return f; }
    return null;
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return null;
  const el = node as ReactElement<any>;
  if (match(el.props)) return el;
  return findElement(el.props?.children, match);
}

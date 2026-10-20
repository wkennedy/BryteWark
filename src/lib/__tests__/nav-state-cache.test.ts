import { describe, it, expect, beforeEach } from 'vitest';
import { rememberNavState, restoredNavState, clearNavState, withoutRoute } from '../nav-state-cache';

const tabs = { index: 0, routes: [{ key: 'm', name: 'Mail' }] };
const root = (routes: any[], index = routes.length - 1) => ({ key: 'r', index, routeNames: [], routes, type: 'stack', stale: false }) as any;

describe('nav-state-cache', () => {
  beforeEach(() => clearNavState());

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
});

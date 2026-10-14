import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({
  NativeModules: {}, Linking: { openURL: async () => undefined },
  NativeEventEmitter: class { addListener() { return { remove: () => undefined }; } removeAllListeners() {} },
  Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => undefined }) },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal', ScrollView: 'ScrollView',
  StyleSheet: { create: (s: unknown) => s },
  Alert: { alert: vi.fn() },
  Platform: { OS: 'android', select: (s: any) => s.android ?? s.default },
}));
vi.mock('lucide-react-native', () => ({ Plus: 'Plus', Star: 'Star', Trash2: 'Trash2', X: 'X' }));
vi.mock('../../../theme/colors', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }));

import type { ReactElement } from 'react';
import { IdentitySettings } from '../IdentitySettings';
import { renderComponent, findElement, resetHooks } from '../../email/__tests__/hook-harness';
import { jmapClient } from '../../../api/jmap-client';
import { useSettingsStore } from '../../../stores/settings-store';

const ident = (id: string, email: string, mayDelete = true) => ({ id, name: email, email, mayDelete });
const ownIds = [ident('b', 'bob@x', false), ident('c', 'team@x'), ident('d', 'bob2@x')];
const accounts = {
  a: { name: 'Bob', identities: ownIds },
  f: { name: 'Team', identities: [ident('t1', 'team@x', false)] },
};

function findAll(node: unknown, match: (p: Record<string, any>) => boolean, out: ReactElement<any>[] = []) {
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, match, out)); return out; }
  if (!node || typeof node !== 'object' || !('props' in node)) return out;
  const el = node as ReactElement<any>;
  if (match(el.props)) out.push(el);
  findAll(el.props?.children, match, out);
  return out;
}
const text = (node: unknown) => findAll(node, (p) => typeof p.children === 'string').map((e) => e.props.children as string);
const stars = (row: ReactElement<any>) => findAll(row, (p) => p.accessibilityLabel === 'Set as primary');
const starFill = (row: ReactElement<any>) => findElement(row, (p) => 'fill' in p)!.props.fill;
const hasDelete = (row: ReactElement<any>) => findAll(row, (p) => p.accessibilityLabel === 'Delete').length > 0;

let updateSetting: ReturnType<typeof vi.fn>;
function setup(state: Record<string, unknown>) {
  useSettingsStore.setState({
    identities: ownIds, sendAccounts: accounts, preferredIdentityIds: {}, loading: false, error: null,
    fetchIdentities: async () => undefined, updateSetting, ...state,
  } as never);
  return renderComponent(IdentitySettings, {});
}
// The row holding `email` for the section it sits in: group rows are View, own rows Pressable.
const row = (view: ReturnType<typeof setup>, email: string, type: string) =>
  findAll(view.tree(), (p) => text(p.children).includes(email)).length
    ? (findAll(view.tree(), () => true) as ReactElement<any>[]).filter((e) => e.type === type && text(e.props.children).includes(email) && findAll(e.props.children, (p) => 'accessibilityLabel' in p || 'fill' in p).length >= 0)
    : [];

describe('IdentitySettings default-sender star', () => {
  beforeEach(() => {
    updateSetting = vi.fn();
    vi.spyOn(jmapClient, 'isConnected', 'get').mockReturnValue(true);
    vi.spyOn(jmapClient, 'accountId', 'get').mockReturnValue('a');
  });
  afterEach(() => { resetHooks(); vi.restoreAllMocks(); });

  it('lists a group under its account name with a star-only row', () => {
    const view = setup({});
    const all = text(view.tree());
    expect(all).toContain('Team');
    expect(all).toContain('Your account');
    // team@ appears once among the own rows (hidden duplicate) and once as the group row.
    const [group] = row(view, 'team@x', 'View').filter((e) => !findAll(e, (p) => p.accessibilityLabel === 'Delete').length && stars(e).length);
    expect(group).toBeDefined();
    expect(stars(group)).toHaveLength(1);
    expect(hasDelete(group)).toBe(false);
    // Name and address of the one row: the hidden own duplicate adds none.
    expect(all.filter((s) => s === 'team@x')).toHaveLength(2);
  });

  it('stores the composite id when a group row is starred', () => {
    const view = setup({});
    const [group] = row(view, 'team@x', 'View').filter((e) => stars(e).length);
    stars(group)[0].props.onPress();
    expect(updateSetting).toHaveBeenCalledWith('preferredIdentityIds', { a: 'f/t1' });
  });

  it('keeps own rows editable and deletable, storing the plain id', () => {
    const view = setup({});
    const [own] = row(view, 'bob2@x', 'Pressable').filter((e) => typeof e.props.onPress === 'function' && e.props.style);
    expect(hasDelete(own)).toBe(true);
    stars(own)[0].props.onPress();
    expect(updateSetting).toHaveBeenCalledWith('preferredIdentityIds', { a: 'd' });
    own.props.onPress();
    expect(findElement(view.tree(), (p) => p.visible === true)).not.toBeNull();
  });

  it('fills the star of a stored composite id, and of a plain id aliased to the group row', () => {
    for (const stored of ['f/t1', 'c']) {
      const view = setup({ preferredIdentityIds: { a: stored } });
      const [group] = row(view, 'team@x', 'View').filter((e) => stars(e).length);
      expect(starFill(group)).toBe('#000');
      const [own] = row(view, 'bob2@x', 'Pressable').filter((e) => e.props.style);
      expect(starFill(own)).toBe('transparent');
      resetHooks();
    }
  });

  it('un-stars an aliased default by removing it', () => {
    const view = setup({ preferredIdentityIds: { a: 'c' } });
    const [group] = row(view, 'team@x', 'View').filter((e) => stars(e).length);
    stars(group)[0].props.onPress();
    expect(updateSetting).toHaveBeenCalledWith('preferredIdentityIds', {});
  });

  it('is unchanged without a shared account', () => {
    const view = setup({ sendAccounts: {} });
    expect(text(view.tree())).not.toContain('Your account');
    expect(text(view.tree())).not.toContain('Team');
    expect(row(view, 'team@x', 'Pressable').length).toBeGreaterThan(0);
  });
});

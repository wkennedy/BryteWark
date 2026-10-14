import { describe, it, expect } from 'vitest';
import {
  buildSendIdentities,
  groupSendIdentities,
  identitySendsAs,
  identitySendsAsOrSubaddress,
  routeOfIdentity,
} from '../send-identities';

import type { Identity } from '../../api/types';

const ident = (id: string, name: string, email: string): Identity => ({ id, name, email, mayDelete: true });

const own = { name: 'd', identities: [
  ident('b', 'Bob', 'bob@x'),
  ident('c', 'Team', 'team@x'),
] };
const group = { name: 'team@x', identities: [ident('b', 'Team', 'team@x')] };

describe('buildSendIdentities', () => {
  it('merges the group identity and hides the duplicate own one', () => {
    const { list, aliases } = buildSendIdentities('d', { d: own, f: group });
    expect(list.map((i) => i.id)).toEqual(['b', 'f/b']);
    expect(list[1]).toMatchObject({ jmapAccountId: 'f', email: 'team@x' });
    expect(aliases).toEqual({ c: 'f/b' });
  });

  it('lists only own identities with no shared accounts', () => {
    const { list, aliases } = buildSendIdentities('d', { d: own });
    expect(list.map((i) => i.id)).toEqual(['b', 'c']);
    expect(list.every((i) => i.jmapAccountId === 'd')).toBe(true);
    expect(aliases).toEqual({});
  });

  it('never hides a wildcard own identity', () => {
    const wild = { name: 'd', identities: [ident('w', '', '*@x')] };
    const { list } = buildSendIdentities('d', { d: wild, f: group });
    expect(list.map((i) => i.id)).toEqual(['w', 'f/b']);
  });

  it('keeps both rows when two shared accounts list one address; first wins the alias', () => {
    const g2 = { name: 'g2', identities: [ident('z', '', 'team@x')] };
    const { list, aliases } = buildSendIdentities('d', { d: own, f: group, g: g2 });
    expect(list.map((i) => i.id)).toEqual(['b', 'f/b', 'g/z']);
    expect(aliases).toEqual({ c: 'f/b' });
  });
});

describe('routeOfIdentity', () => {
  it('splits a composite id and leaves an own id in its account', () => {
    const { list } = buildSendIdentities('d', { d: own, f: group });
    expect(routeOfIdentity(list[1])).toEqual({ jmapAccountId: 'f', identityId: 'b' });
    expect(routeOfIdentity(list[0])).toEqual({ jmapAccountId: 'd', identityId: 'b' });
  });
});

describe('identitySendsAs', () => {
  it('matches case-insensitively, by wildcard domain, and not otherwise', () => {
    expect(identitySendsAs({ email: 'Team@X' }, 'team@x')).toBe(true);
    expect(identitySendsAs({ email: '*@x' }, 'any@x')).toBe(true);
    expect(identitySendsAs({ email: 'team@x' }, 'bob@x')).toBe(false);
  });

  it('lets a wildcard cover only well-formed addresses in its domain', () => {
    expect(identitySendsAs({ email: '*@x' }, 'a@b@x')).toBe(false);
    expect(identitySendsAs({ email: '*@x' }, '@x')).toBe(false);
    expect(identitySendsAs({ email: '*@x' }, 'a@x')).toBe(true);
  });

  it('does not let a malformed wildcard without a domain cover anything', () => {
    expect(identitySendsAs({ email: '*@' }, 'a@')).toBe(false);
    expect(identitySendsAs({ email: '*@' }, 'a@x')).toBe(false);
  });
});

describe('identitySendsAsOrSubaddress', () => {
  it('covers the address itself and a tagged sub-address of it', () => {
    expect(identitySendsAsOrSubaddress({ email: 'team@x' }, 'team@x')).toBe(true);
    expect(identitySendsAsOrSubaddress({ email: 'team@x' }, 'Team+Tag@X')).toBe(true);
  });

  it('uses the given delimiter', () => {
    expect(identitySendsAsOrSubaddress({ email: 'team@x' }, 'team-tag@x', '-')).toBe(true);
    expect(identitySendsAsOrSubaddress({ email: 'team@x' }, 'team+tag@x', '-')).toBe(false);
  });

  it('refuses another local part, another domain, an empty tag or a malformed address', () => {
    expect(identitySendsAsOrSubaddress({ email: 'team@x' }, 'bob@x')).toBe(false);
    expect(identitySendsAsOrSubaddress({ email: 'team@x' }, 'teamx+tag@x')).toBe(false);
    expect(identitySendsAsOrSubaddress({ email: 'team@x' }, 'team+tag@y')).toBe(false);
    expect(identitySendsAsOrSubaddress({ email: 'team@x' }, 'team+@x')).toBe(false);
    expect(identitySendsAsOrSubaddress({ email: 'team@x' }, 'team+a@b@x')).toBe(false);
  });

  it('leaves a wildcard identity to the wildcard rules', () => {
    expect(identitySendsAsOrSubaddress({ email: '*@x' }, 'team+tag@x')).toBe(true);
    expect(identitySendsAsOrSubaddress({ email: '*@x' }, 'team+tag@y')).toBe(false);
    expect(identitySendsAsOrSubaddress({ email: '*@x' }, '*+tag@x')).toBe(identitySendsAs({ email: '*@x' }, '*+tag@x'));
  });
});

describe('groupSendIdentities', () => {
  it('puts the own account first without a label', () => {
    const { list } = buildSendIdentities('d', { d: own, f: group });
    const sections = groupSendIdentities(list, 'd');
    expect(sections.map(({ jmapAccountId, label }) => ({ jmapAccountId, label })))
      .toEqual([{ jmapAccountId: 'd', label: null }, { jmapAccountId: 'f', label: 'team@x' }]);
  });
});

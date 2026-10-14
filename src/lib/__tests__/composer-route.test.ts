import { describe, it, expect, vi } from 'vitest';
import {
  resolveIdentityAlias, sameAccountIdentities, planComposerSend, sendCapabilityAccountId, composerIdentitySet,
  pickDefaultIdentityId, ownAccountEmails, loadComposerSendIdentities, reselectIdentityId, signatureIdentityForSend,
} from '../composer-route';
import { writeIdentityCache } from '../identity-cache';
import { RoutedSendError } from '../routed-send';
import { pickSubmissionIdentity } from '../envelope-sender';
import type { SendIdentity } from '../send-identities';

const ident = (id: string, email: string, jmapAccountId: string, accountName = jmapAccountId): SendIdentity => ({
  id, email, name: '', mayDelete: true, jmapAccountId, accountName,
});
const own = ident('b', 'bob@x', 'a', 'Bob');
const ownWildcard = ident('w', '*@x', 'a', 'Bob');
const routed = ident('f/b', 'team@x', 'f', 'Team');

describe('resolveIdentityAlias', () => {
  it('follows a hidden duplicate to its shared copy', () => {
    expect(resolveIdentityAlias('c', { c: 'f/b' })).toBe('f/b');
  });
  it('keeps an id without an alias', () => {
    expect(resolveIdentityAlias('b', {})).toBe('b');
  });
  it('is null without an id', () => {
    expect(resolveIdentityAlias(null, { c: 'f/b' })).toBeNull();
    expect(resolveIdentityAlias(undefined, {})).toBeNull();
    expect(resolveIdentityAlias('', {})).toBeNull();
  });
});

describe('sameAccountIdentities', () => {
  it('keeps only the chosen identity\'s account', () => {
    expect(sameAccountIdentities([own, ownWildcard, routed], routed)).toEqual([routed]);
    expect(sameAccountIdentities([own, ownWildcard, routed], own)).toEqual([own, ownWildcard]);
  });
  it('never lets an override pick your own wildcard for a routed identity', () => {
    const pool = sameAccountIdentities([own, ownWildcard, routed], routed);
    expect(pickSubmissionIdentity(pool, routed, 'team+tag@x')).toBe(routed);
    expect(pickSubmissionIdentity(pool, routed, 'bob@x')).toBe(routed);
  });
});

describe('planComposerSend', () => {
  it('sends your own identity from your own account, online or offline', () => {
    expect(planComposerSend({ submission: own, ownAccountId: 'a', online: true })).toEqual({ kind: 'own' });
    expect(planComposerSend({ submission: own, ownAccountId: 'a', online: false })).toEqual({ kind: 'own' });
  });
  it('routes a group identity to its account with the server id', () => {
    expect(planComposerSend({ submission: routed, ownAccountId: 'a', online: true })).toEqual({
      kind: 'routed', route: { jmapAccountId: 'f', identityId: 'b' }, accountName: 'Team',
    });
  });
  it('refuses a group identity offline', () => {
    const plan = planComposerSend({ submission: routed, ownAccountId: 'a', online: false });
    expect(plan.kind).toBe('refuse');
    if (plan.kind !== 'refuse') return;
    expect(plan.error).toBeInstanceOf(RoutedSendError);
    expect(plan.error.reason).toBe('offline');
    expect(plan.error.address).toBe('team@x');
    expect(plan.error.account).toBe('Team');
  });
  it('routes a plain id to the account it was read from, never your own', () => {
    const elsewhere = ident('b', 'bob@x', 'z');
    expect(planComposerSend({ submission: elsewhere, ownAccountId: 'a', online: true })).toEqual({
      kind: 'routed', route: { jmapAccountId: 'z', identityId: 'b' }, accountName: 'z',
    });
  });
});

describe('sendCapabilityAccountId', () => {
  it('is the group account for a routed identity', () => {
    expect(sendCapabilityAccountId(routed, 'a')).toBe('f');
  });
  it('is your own account without one, or for your own identity', () => {
    expect(sendCapabilityAccountId(null, 'a')).toBe('a');
    expect(sendCapabilityAccountId(null, undefined)).toBeUndefined();
    expect(sendCapabilityAccountId(own, 'a')).toBe('a');
  });
});

describe('composerIdentitySet', () => {
  const accounts = {
    a: { name: 'Bob', identities: [{ id: 'b', email: 'bob@x', name: '', mayDelete: false }] },
    f: { name: 'Team', identities: [{ id: 'b', email: 'team@x', name: '', mayDelete: false }] },
  };
  it('builds the merged list for your own account', () => {
    const set = composerIdentitySet({ accounts, source: 'fresh', error: null }, 'a');
    expect(set?.ownAccountId).toBe('a');
    expect(set?.list.map((i) => i.id)).toEqual(['b', 'f/b']);
  });
  it('keeps what is shown when nothing loaded', () => {
    expect(composerIdentitySet({ accounts: {}, source: 'none', error: 'x' }, 'a')).toBeNull();
  });
  it('keeps what is shown when your own account is unknown', () => {
    expect(composerIdentitySet({ accounts, source: 'cache', error: 'x' }, null)).toBeNull();
    expect(composerIdentitySet({ accounts, source: 'cache', error: 'x' }, '')).toBeNull();
  });
  it('ignores a cache without your own account, so no identity of yours gets a routed id', () => {
    const { f } = accounts;
    expect(composerIdentitySet({ accounts: { f }, source: 'cache', error: 'x' }, 'a')).toBeNull();
  });
});

describe('ownAccountEmails', () => {
  const id = (i: string, email: string) => ({ id: i, email, name: '', mayDelete: true });
  it('keeps your own addresses, hidden duplicates included, and no group-only ones', () => {
    const accounts = {
      a: { name: 'Bob', identities: [id('b', 'bob@x'), id('c', 'team@x')] },
      f: { name: 'Team', identities: [id('b', 'team@x'), id('d', 'other@x')] },
    };
    expect(ownAccountEmails(accounts, 'a')).toEqual(['bob@x', 'team@x']);
    const set = composerIdentitySet({ accounts, source: 'fresh', error: null }, 'a');
    expect(set?.ownEmails).toEqual(['bob@x', 'team@x']);
  });
  it('is your own list without shared accounts', () => {
    const accounts = { a: { name: 'Bob', identities: [id('b', 'bob@x'), id('w', '*@x')] } };
    expect(ownAccountEmails(accounts, 'a')).toEqual(['bob@x', '*@x']);
    expect(composerIdentitySet({ accounts, source: 'fresh', error: null }, 'a')?.ownEmails).toEqual(['bob@x', '*@x']);
  });
  it('is empty when your own account is missing', () => {
    expect(ownAccountEmails({}, 'a')).toEqual([]);
  });
});

describe('loadComposerSendIdentities', () => {
  const id = (i: string, email: string) => ({ id: i, email, name: '', mayDelete: false });
  const accounts = {
    a: { name: 'Bob', identities: [id('b', 'bob@x')] },
    f: { name: 'Team', identities: [id('b', 'team@x')] },
  };
  const noConnection = () => { throw new Error('Not connected'); };

  it('falls back to the cache when there is no connection to take a scope from', async () => {
    await writeIdentityCache('app-offline', accounts, 'a');
    const fetch = vi.fn();
    const r = await loadComposerSendIdentities({
      appAccountId: 'app-offline', ownJmapAccountId: 'a', fetchAccountId: 'a', scope: noConnection, fetch,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(r.source).toBe('cache');
    expect(r.error).toBe('Not connected');
    expect(r.set?.ownAccountId).toBe('a');
    expect(r.set?.list.map((i) => i.id)).toEqual(['b', 'f/b']);
  });

  it('reports the error, without rejecting, offline with no owner', async () => {
    const r = await loadComposerSendIdentities({
      appAccountId: undefined, ownJmapAccountId: null, fetchAccountId: '', scope: noConnection, fetch: vi.fn(),
    });
    expect(r).toEqual({ source: 'none', set: null, error: 'Not connected' });
  });

  it('reads a fresh list in the scope\'s account and treats it as your own', async () => {
    const fetch = vi.fn(async () => accounts);
    const r = await loadComposerSendIdentities({
      appAccountId: undefined, ownJmapAccountId: null, fetchAccountId: '',
      scope: () => ({ gen: 3, accountId: 'a' }), fetch,
    });
    expect(fetch).toHaveBeenCalledWith({ gen: 3, accountId: 'a' });
    expect(r.source).toBe('fresh');
    expect(r.set?.ownAccountId).toBe('a');
  });

  it('uses the cache when the owner stops being active during the fetch', async () => {
    await writeIdentityCache('app-switched', accounts, 'a');
    const r = await loadComposerSendIdentities({
      appAccountId: 'app-switched', ownJmapAccountId: 'a', fetchAccountId: 'a',
      scope: () => ({ gen: 3, accountId: 'a' }), fetch: async () => accounts, stillOwner: () => false,
    });
    expect(r.source).toBe('cache');
  });
});

describe('reselectIdentityId', () => {
  const id = (i: string, email: string) => ({ id: i, email, name: '', mayDelete: false });
  // The cache had no group yet: your own team@ (c) was shown and chosen.
  const fresh = composerIdentitySet({
    accounts: {
      a: { name: 'Bob', identities: [id('b', 'bob@x'), id('c', 'team@x')] },
      f: { name: 'Team', identities: [id('b', 'team@x')] },
    },
    source: 'fresh',
    error: null,
  }, 'a')!;

  it('follows a choice the fresh list hides to its group copy', () => {
    expect(reselectIdentityId('c', fresh)).toBe('f/b');
  });
  it('keeps a choice still in the list, or none', () => {
    expect(reselectIdentityId('b', fresh)).toBe('b');
    expect(reselectIdentityId('f/b', fresh)).toBe('f/b');
    expect(reselectIdentityId(null, fresh)).toBeNull();
  });
  it('keeps a choice with no alias for the selection rules to handle', () => {
    expect(reselectIdentityId('gone', fresh)).toBe('gone');
  });
});

describe('signatureIdentityForSend', () => {
  const sig = (i: SendIdentity, textSignature?: string): SendIdentity => ({ ...i, textSignature });
  const ownPrimary = sig({ ...ident('1', 'me@x', 'a', 'Me'), mayDelete: false }, 'mine');
  const ownAlias = sig(ident('2', 'alias@x', 'a', 'Me'));
  const groupPrimary = (textSignature?: string) =>
    sig({ ...ident('f/7', 'team@x', 'f', 'Team'), mayDelete: false }, textSignature);
  const groupAlias = sig(ident('f/8', 'sales@x', 'f', 'Team'));

  it('gives a group identity without a signature none of yours', () => {
    const list = [ownPrimary, ownAlias, groupPrimary(), groupAlias];
    expect(signatureIdentityForSend(groupAlias, list)).toBeNull();
  });
  it('gives a group identity its own account primary signature', () => {
    const gp = groupPrimary('team sig');
    expect(signatureIdentityForSend(groupAlias, [ownPrimary, ownAlias, gp, groupAlias])).toBe(gp);
  });
  it('keeps an identity that has its own signature', () => {
    const signed = sig(ident('f/9', 'x@x', 'f', 'Team'), 'own');
    expect(signatureIdentityForSend(signed, [ownPrimary, groupPrimary(), signed])).toBe(signed);
  });
  it('still gives your own alias your own primary signature', () => {
    expect(signatureIdentityForSend(ownAlias, [ownPrimary, ownAlias, groupPrimary('team sig'), groupAlias])).toBe(ownPrimary);
  });
  it('is null without an identity', () => {
    expect(signatureIdentityForSend(null, [ownPrimary])).toBeNull();
  });
});

describe('pickDefaultIdentityId', () => {
  const primary = { ...own, mayDelete: false };
  const list = [ownWildcard, primary, routed];
  it('takes the stored composite id of a group identity', () => {
    expect(pickDefaultIdentityId(list, {}, 'f/b', 'x@y')).toBe('f/b');
  });
  it('follows a hidden duplicate to the group row', () => {
    expect(pickDefaultIdentityId(list, { c: 'f/b' }, 'c', 'x@y')).toBe('f/b');
  });
  it('falls back like a missing own default when the group identity is gone', () => {
    expect(pickDefaultIdentityId([ownWildcard, primary], {}, 'f/b', 'x@y')).toBe('b');
    expect(pickDefaultIdentityId([ownWildcard, primary], {}, 'gone', 'x@y')).toBe('b');
  });
  it('prefers the active account address, then the primary, then the first', () => {
    expect(pickDefaultIdentityId(list, {}, undefined, 'TEAM@x')).toBe('f/b');
    expect(pickDefaultIdentityId(list, {}, undefined, 'nobody@y')).toBe('b');
    expect(pickDefaultIdentityId([ownWildcard], {}, undefined, null)).toBe('w');
    expect(pickDefaultIdentityId([], {}, 'f/b', 'x@y')).toBeUndefined();
  });
});

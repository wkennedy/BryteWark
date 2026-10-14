import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Identity } from '../../api/types';
import type { SendableIdentities } from '../../api/identity';
import {
  identityCacheKey,
  IDENTITY_CACHE_PREFIX,
  LEGACY_IDENTITY_CACHE_PREFIX,
  readIdentityCache,
  writeIdentityCache,
  removeIdentityCache,
  loadComposerIdentities,
  MAX_CACHED_IDENTITIES,
} from '../identity-cache';

const A = 'a@mail.example.com';
const B = 'b@mail.example.com';
const OWN = 'd';

function ident(id: string, extra: Partial<Identity> = {}): Identity {
  return { id, name: `Name ${id}`, email: `${id}@example.com`, mayDelete: true, ...extra };
}

function own(...identities: Identity[]): SendableIdentities {
  return { [OWN]: { name: 'Me', identities } };
}

const ids = (s: SendableIdentities, acct: string) => (s[acct]?.identities ?? []).map((i) => i.id);
const legacyKey = (a: string) => `${LEGACY_IDENTITY_CACHE_PREFIX}${a}`;

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('identity cache', () => {
  it('keys the cache by app account under the v2 prefix', () => {
    expect(IDENTITY_CACHE_PREFIX).toBe('webmail:identities:v2:');
    expect(LEGACY_IDENTITY_CACHE_PREFIX).toBe('webmail:identities:v1:');
    expect(identityCacheKey(A)).toBe(`webmail:identities:v2:${A}`);
  });

  it('round-trips what the composer needs, and nothing else', async () => {
    const full = {
      ...ident('i1', {
        replyTo: [{ name: 'R', email: 'r@example.com' }],
        bcc: [{ email: 'b@example.com' }],
        textSignature: '-- me',
        htmlSignature: '<p>me</p>',
        mayDelete: false,
      }),
      somethingElse: 'secret',
    } as Identity;
    await writeIdentityCache(A, own(full));
    const back = await readIdentityCache(A, OWN);
    expect(back).toEqual({ [OWN]: { name: 'Me', identities: [{
      id: 'i1', name: 'Name i1', email: 'i1@example.com',
      replyTo: [{ name: 'R', email: 'r@example.com' }],
      bcc: [{ email: 'b@example.com' }],
      textSignature: '-- me', htmlSignature: '<p>me</p>', mayDelete: false,
    }] } });
  });

  it('round-trips two accounts', async () => {
    await writeIdentityCache(A, {
      [OWN]: { name: 'Me', identities: [ident('b')] },
      g1: { name: 'Team', identities: [ident('b'), ident('t')] },
    });
    const back = await readIdentityCache(A, OWN);
    expect(Object.keys(back).sort()).toEqual([OWN, 'g1']);
    expect(back.g1.name).toBe('Team');
    expect(ids(back, 'g1')).toEqual(['b', 't']);
  });

  it('keeps each app account separate', async () => {
    await writeIdentityCache(A, own(ident('a1')));
    await writeIdentityCache(B, own(ident('b1')));
    expect(ids(await readIdentityCache(A, OWN), OWN)).toEqual(['a1']);
    expect(ids(await readIdentityCache(B, OWN), OWN)).toEqual(['b1']);
  });

  it('reads nothing for an account that has no cache', async () => {
    expect(await readIdentityCache(A, OWN)).toEqual({});
  });

  it('reads a corrupt or non-object value as empty', async () => {
    await AsyncStorage.setItem(identityCacheKey(A), '{not json');
    expect(await readIdentityCache(A, OWN)).toEqual({});
    await AsyncStorage.setItem(identityCacheKey(A), JSON.stringify([{ id: 'x' }]));
    expect(await readIdentityCache(A, OWN)).toEqual({});
    await AsyncStorage.setItem(identityCacheKey(A), JSON.stringify('str'));
    expect(await readIdentityCache(A, OWN)).toEqual({});
  });

  it('drops malformed accounts and malformed identities', async () => {
    await AsyncStorage.setItem(identityCacheKey(A), JSON.stringify({
      good: { name: 'G', identities: [
        { id: 'ok', name: 'Ok', email: 'ok@example.com', mayDelete: true },
        { id: 5, name: 'Bad', email: 'bad@example.com' },
        null,
        { id: 'noemail', name: 'x' },
        { id: 'badreply', name: 'x', email: 'x@example.com', replyTo: 'nope', mayDelete: true },
      ] },
      noarray: { name: 'N', identities: 'nope' },
      notobj: 7,
      nul: null,
    }));
    const back = await readIdentityCache(A, OWN);
    expect(Object.keys(back)).toEqual(['good']);
    expect(ids(back, 'good')).toEqual(['ok', 'badreply']);
    expect(back.good.identities[1].replyTo).toBeUndefined();
  });

  it('bounds the identities across all accounts, keeping your own first', async () => {
    const many = (p: string, n: number) => Array.from({ length: n }, (_, k) => ident(`${p}${k}`));
    await writeIdentityCache(A, {
      g1: { name: 'Team', identities: many('g', 40) },
      [OWN]: { name: 'Me', identities: many('o', 30) },
    }, OWN);
    const back = await readIdentityCache(A, OWN);
    const total = Object.values(back).reduce((n, a) => n + a.identities.length, 0);
    expect(total).toBe(MAX_CACHED_IDENTITIES);
    expect(ids(back, OWN)).toHaveLength(30);
    expect(ids(back, 'g1')).toHaveLength(20);
  });

  it('bounds the stored size, dropping identities that do not fit', async () => {
    const huge = 'x'.repeat(200_000);
    await writeIdentityCache(A, own(ident('i1'), ident('i2', { htmlSignature: huge }), ident('i3', { htmlSignature: huge })));
    const raw = await AsyncStorage.getItem(identityCacheKey(A));
    expect(raw!.length).toBeLessThanOrEqual(256 * 1024);
    expect(ids(await readIdentityCache(A, OWN), OWN)).toEqual(['i1', 'i2']);
  });

  it('keeps your own account first by size even when account ids are numeric', async () => {
    const huge = 'x'.repeat(200_000);
    await writeIdentityCache(A, {
      '2': { name: 'Team', identities: [ident('s1', { htmlSignature: huge })] },
      '9': { name: 'Me', identities: [ident('o1', { htmlSignature: huge })] },
    }, '9');
    const back = await readIdentityCache(A, '9');
    expect(ids(back, '9')).toEqual(['o1']);
    expect(ids(back, '2')).toEqual([]);
  });

  it('migrates a v1 list as the own account', async () => {
    await AsyncStorage.setItem(legacyKey(A), JSON.stringify([ident('bob')]));
    const back = await readIdentityCache(A, 'd');
    expect(back).toEqual({ d: { name: 'd', identities: [ident('bob')] } });
  });

  it('ignores v1 when the own account id is unknown', async () => {
    await AsyncStorage.setItem(legacyKey(A), JSON.stringify([ident('bob')]));
    expect(await readIdentityCache(A, null)).toEqual({});
  });

  it('prefers v2 over v1', async () => {
    await AsyncStorage.setItem(legacyKey(A), JSON.stringify([ident('old')]));
    await writeIdentityCache(A, own(ident('new')));
    // The write already removed v1; restore it to prove v2 wins on read.
    await AsyncStorage.setItem(legacyKey(A), JSON.stringify([ident('old')]));
    expect(ids(await readIdentityCache(A, OWN), OWN)).toEqual(['new']);
  });

  it('a write removes the v1 key', async () => {
    await AsyncStorage.setItem(legacyKey(A), JSON.stringify([ident('bob')]));
    await writeIdentityCache(A, own(ident('n')));
    expect(await AsyncStorage.getItem(legacyKey(A))).toBeNull();
  });

  it('removes only that account\'s cache, both versions', async () => {
    await writeIdentityCache(A, own(ident('a1')));
    await AsyncStorage.setItem(legacyKey(A), JSON.stringify([ident('bob')]));
    await writeIdentityCache(B, own(ident('b1')));
    await removeIdentityCache(A);
    expect(await AsyncStorage.getItem(identityCacheKey(A))).toBeNull();
    expect(await AsyncStorage.getItem(legacyKey(A))).toBeNull();
    expect(ids(await readIdentityCache(B, OWN), OWN)).toEqual(['b1']);
  });

  it('never throws on storage errors', async () => {
    const get = vi.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    const setItem = vi.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
    try {
      expect(await readIdentityCache(A, OWN)).toEqual({});
      await expect(writeIdentityCache(A, own(ident('a1')))).resolves.toBeUndefined();
    } finally {
      get.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('loadComposerIdentities', () => {
  it('uses the fresh list and caches it for the account', async () => {
    await writeIdentityCache(A, own(ident('old')));
    const res = await loadComposerIdentities(A, OWN, async () => own(ident('new')));
    expect(res).toEqual({ accounts: own(ident('new')), source: 'fresh', error: null });
    expect(ids(await readIdentityCache(A, OWN), OWN)).toEqual(['new']);
  });

  it('falls back to the cached accounts when the fetch fails', async () => {
    await writeIdentityCache(A, own(ident('a1')));
    const res = await loadComposerIdentities(A, OWN, async () => { throw new Error('offline'); });
    expect(res.source).toBe('cache');
    expect(ids(res.accounts, OWN)).toEqual(['a1']);
    expect(res.error).toBe('offline');
  });

  it('gives nothing when the fetch fails and there is no cache', async () => {
    const res = await loadComposerIdentities(A, OWN, async () => { throw new Error('offline'); });
    expect(res).toEqual({ accounts: {}, source: 'none', error: 'offline' });
  });

  it('a cache with no identities in any account is none', async () => {
    await writeIdentityCache(A, { [OWN]: { name: 'Me', identities: [] } });
    const res = await loadComposerIdentities(A, OWN, async () => { throw new Error('offline'); });
    expect(res.source).toBe('none');
  });

  it('never uses another account\'s cache', async () => {
    await writeIdentityCache(B, own(ident('b1')));
    const res = await loadComposerIdentities(A, OWN, async () => { throw new Error('offline'); });
    expect(res).toEqual({ accounts: {}, source: 'none', error: 'offline' });
  });

  it('without an owner it neither reads nor writes a cache', async () => {
    await writeIdentityCache(A, own(ident('a1')));
    const failed = await loadComposerIdentities(null, null, async () => { throw new Error('offline'); });
    expect(failed.source).toBe('none');
    const fresh = await loadComposerIdentities(null, null, async () => own(ident('n1')));
    expect(fresh.source).toBe('fresh');
    expect(ids(await readIdentityCache(A, OWN), OWN)).toEqual(['a1']);
  });

  it('a fresh empty result replaces the cached one', async () => {
    await writeIdentityCache(A, own(ident('a1')));
    const res = await loadComposerIdentities(A, OWN, async () => ({}));
    expect(res.source).toBe('fresh');
    expect(await readIdentityCache(A, OWN)).toEqual({});
  });
});

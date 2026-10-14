// A small per-account copy of the sending identities, so a composer opened
// offline can still fill From and queue the send. Keyed by the app account id
// (the account registry id, unique per login and server); a cache is only
// ever read for the account that wrote it. Forgotten when the account signs
// out (account-data-cleanup). The row holds one entry per JMAP account the
// login can send from (its own and shared ones); ids collide across those
// accounts, so they are never merged.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { EmailAddress, Identity } from '../api/types';
import type { AccountIdentities, SendableIdentities } from '../api/identity';

export const IDENTITY_CACHE_PREFIX = 'webmail:identities:v2:';
/** The old single-account list: read once as the own account, dropped on the next write. */
export const LEGACY_IDENTITY_CACHE_PREFIX = 'webmail:identities:v1:';
export const MAX_CACHED_IDENTITIES = 50;
/** Upper bound on the stored JSON, in UTF-16 code units. */
export const MAX_IDENTITY_CACHE_CHARS = 256 * 1024;

export function identityCacheKey(appAccountId: string): string {
  return `${IDENTITY_CACHE_PREFIX}${appAccountId}`;
}

function legacyKey(appAccountId: string): string {
  return `${LEGACY_IDENTITY_CACHE_PREFIX}${appAccountId}`;
}

function cleanAddresses(raw: unknown): EmailAddress[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EmailAddress[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object' || typeof (a as EmailAddress).email !== 'string') continue;
    const { name, email } = a as EmailAddress;
    out.push(typeof name === 'string' ? { name, email } : { email });
  }
  return out;
}

/** The fields the composer uses, or null when the row is not an identity. */
function cleanIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.email !== 'string') return null;
  const out: Identity = {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : '',
    email: r.email,
    mayDelete: r.mayDelete === true,
  };
  const replyTo = cleanAddresses(r.replyTo);
  if (replyTo) out.replyTo = replyTo;
  const bcc = cleanAddresses(r.bcc);
  if (bcc) out.bcc = bcc;
  if (typeof r.textSignature === 'string') out.textSignature = r.textSignature;
  if (typeof r.htmlSignature === 'string') out.htmlSignature = r.htmlSignature;
  return out;
}

function cleanIdentities(raw: unknown): Identity[] {
  return Array.isArray(raw) ? raw.map(cleanIdentity).filter((i): i is Identity => i !== null) : [];
}

/** Your own account first, so the bounds cut shared accounts before it. */
function ownFirst(ids: string[], own: string | null | undefined): string[] {
  return own && ids.includes(own) ? [own, ...ids.filter((id) => id !== own)] : ids;
}

function boundCount(accounts: SendableIdentities, own: string | null | undefined): SendableIdentities {
  const out: SendableIdentities = {};
  let left = MAX_CACHED_IDENTITIES;
  for (const id of ownFirst(Object.keys(accounts), own)) {
    const kept = accounts[id].identities.slice(0, left);
    left -= kept.length;
    out[id] = { name: accounts[id].name, identities: kept };
  }
  return out;
}

/** The account's cached identities per JMAP account; empty when missing, unreadable or corrupt. */
export async function readIdentityCache(
  appAccountId: string,
  ownJmapAccountId: string | null,
): Promise<SendableIdentities> {
  try {
    const raw = await AsyncStorage.getItem(identityCacheKey(appAccountId));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const accounts: SendableIdentities = {};
      for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (!Array.isArray(e.identities)) continue;
        accounts[id] = { name: typeof e.name === 'string' ? e.name : '', identities: cleanIdentities(e.identities) };
      }
      return boundCount(accounts, ownJmapAccountId);
    }
    // No v2 row: an old list is this login's own account's. Without its id we
    // cannot say whose it is, so it is ignored.
    if (!ownJmapAccountId) return {};
    const legacy = await AsyncStorage.getItem(legacyKey(appAccountId));
    if (!legacy) return {};
    const parsed: unknown = JSON.parse(legacy);
    if (!Array.isArray(parsed)) return {};
    return boundCount(
      { [ownJmapAccountId]: { name: ownJmapAccountId, identities: cleanIdentities(parsed) } },
      ownJmapAccountId,
    );
  } catch {
    return {};
  }
}

/**
 * Store the identities of every account, bounded in count and size across the
 * whole row: identities that would push the stored JSON past the limit are
 * left out, the own account's last. Never throws.
 */
export async function writeIdentityCache(
  appAccountId: string,
  accounts: SendableIdentities,
  ownJmapAccountId?: string | null,
): Promise<void> {
  const clean: SendableIdentities = {};
  for (const [id, entry] of Object.entries(accounts)) {
    clean[id] = { name: entry.name, identities: cleanIdentities(entry.identities) };
  }
  const kept: SendableIdentities = {};
  let size = 2; // the surrounding braces
  for (const [id, entry] of Object.entries(boundCount(clean, ownJmapAccountId))) {
    const fitted: AccountIdentities = { name: entry.name, identities: [] };
    // The account's own entry: key, name and the array brackets.
    let accountSize = JSON.stringify({ [id]: fitted }).length - 2 + (Object.keys(kept).length > 0 ? 1 : 0);
    if (size + accountSize > MAX_IDENTITY_CACHE_CHARS) continue;
    for (const identity of entry.identities) {
      const len = JSON.stringify(identity).length + (fitted.identities.length > 0 ? 1 : 0);
      if (size + accountSize + len > MAX_IDENTITY_CACHE_CHARS) continue;
      fitted.identities.push(identity);
      accountSize += len;
    }
    kept[id] = fitted;
    size += accountSize;
  }
  try {
    await AsyncStorage.setItem(identityCacheKey(appAccountId), JSON.stringify(kept));
    await AsyncStorage.removeItem(legacyKey(appAccountId));
  } catch (e) {
    console.warn('[identity-cache] write failed', e);
  }
}

export async function removeIdentityCache(appAccountId: string): Promise<void> {
  await AsyncStorage.multiRemove([identityCacheKey(appAccountId), legacyKey(appAccountId)]);
}

export interface ComposerIdentities {
  accounts: SendableIdentities;
  /** 'fresh' from the server, 'cache' from this account's stored copy, 'none' otherwise. */
  source: 'fresh' | 'cache' | 'none';
  /** The fetch failure, kept when the cache stands in. */
  error: string | null;
}

function hasIdentities(accounts: SendableIdentities): boolean {
  return Object.values(accounts).some((a) => a.identities.length > 0);
}

/**
 * The composer's identities: the server's lists (cached for the owner), else
 * the owner's cached lists. Another account's cache is never used, and without
 * an owner no cache is read or written.
 */
export async function loadComposerIdentities(
  appAccountId: string | null | undefined,
  ownJmapAccountId: string | null,
  fetchIdentities: () => Promise<SendableIdentities>,
): Promise<ComposerIdentities> {
  try {
    const accounts = await fetchIdentities();
    if (appAccountId) await writeIdentityCache(appAccountId, accounts, ownJmapAccountId);
    return { accounts, source: 'fresh', error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Failed to load identities';
    const cached = appAccountId ? await readIdentityCache(appAccountId, ownJmapAccountId) : {};
    return hasIdentities(cached)
      ? { accounts: cached, source: 'cache', error }
      : { accounts: {}, source: 'none', error };
  }
}

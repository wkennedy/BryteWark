// The composer's choices for a send from a shared account's identity, kept
// pure so they are tested without a renderer.

import type { SendableIdentities } from '../api/identity';
import { inAccount, type OpScope } from '../api/op-scope';
import { loadComposerIdentities, type ComposerIdentities } from './identity-cache';
import { RoutedSendError } from './routed-send';
import { signatureIdentityFor } from './signature-utils';
import { buildSendIdentities, routeOfIdentity, type SendIdentity } from './send-identities';

/** The id a saved preference or template names, after the hidden-duplicate alias. */
export function resolveIdentityAlias(id: string | null | undefined, aliases: Record<string, string>): string | null {
  if (!id) return null;
  return aliases[id] ?? id;
}

/**
 * The identity a new message starts from: the preferred one (an alias already
 * followed), else the one matching the active account's address, else the
 * undeletable primary, else the first. A preference naming an identity not in
 * the list (stale, or a group identity no longer sendable) falls through.
 */
export function pickDefaultIdentityId(
  list: SendIdentity[],
  aliases: Record<string, string>,
  preferredId: string | null | undefined,
  activeEmail: string | null | undefined,
): string | undefined {
  const preferred = resolveIdentityAlias(preferredId, aliases);
  return (
    list.find((i) => i.id === preferred)
    ?? list.find((i) => i.email.toLowerCase() === activeEmail?.toLowerCase())
    ?? list.find((i) => !i.mayDelete)
    ?? list[0]
  )?.id;
}

/**
 * Identities eligible as the submission identity: only the chosen identity's
 * own account. Ids collide across accounts, so an override must never move a
 * send to an identity in another account.
 */
export function sameAccountIdentities(list: SendIdentity[], chosen: SendIdentity): SendIdentity[] {
  return list.filter((i) => i.jmapAccountId === chosen.jmapAccountId);
}

/**
 * The identity whose signature `identity` carries when it has none: its own
 * account's primary, never another account's (so a group alias never borrows yours).
 */
export function signatureIdentityForSend(
  identity: SendIdentity | null | undefined,
  list: SendIdentity[],
): SendIdentity | null {
  return signatureIdentityFor(identity, identity ? sameAccountIdentities(list, identity) : []);
}

export type ComposerSendPlan =
  | { kind: 'own' }
  | { kind: 'routed'; route: { jmapAccountId: string; identityId: string }; accountName: string }
  | { kind: 'refuse'; error: RoutedSendError };

/**
 * How the composer sends through `submission`: your own identity goes the
 * usual way (queued when offline); any other account's is routed there, and
 * refused offline, since the Outbox only replays from your own account.
 */
export function planComposerSend(p: { submission: SendIdentity; ownAccountId: string; online: boolean }): ComposerSendPlan {
  const route = routeOfIdentity(p.submission);
  if (route.jmapAccountId === p.ownAccountId && route.identityId === p.submission.id) return { kind: 'own' };
  if (!p.online) {
    return { kind: 'refuse', error: new RoutedSendError('offline', p.submission.email, p.submission.accountName) };
  }
  return { kind: 'routed', route, accountName: p.submission.accountName };
}

/**
 * The account whose submission capabilities (DSN, REQUIRETLS, hold limits)
 * apply: a routed identity's group account, else `ownAccountId` as before.
 */
export function sendCapabilityAccountId(submission: SendIdentity | null, ownAccountId: string | undefined): string | undefined {
  if (!submission) return ownAccountId;
  const route = routeOfIdentity(submission);
  return route.identityId === submission.id ? ownAccountId : route.jmapAccountId;
}

/**
 * The chosen identity after the list changes (a cached list replaced by the
 * fresh one): an own identity the new list hides behind a group's copy
 * follows its alias; anything else is kept for the selection rules.
 */
export function reselectIdentityId(
  selected: string | null,
  set: Pick<ComposerIdentitySet, 'list' | 'aliases'>,
): string | null {
  if (!selected || set.list.some((i) => i.id === selected)) return selected;
  const alias = resolveIdentityAlias(selected, set.aliases);
  return alias && set.list.some((i) => i.id === alias) ? alias : selected;
}

export interface ComposerIdentitySet {
  list: SendIdentity[];
  aliases: Record<string, string>;
  /** The account `list`'s own identities were read from. */
  ownAccountId: string;
  /** Your own account's addresses, hidden duplicates included (see ownAccountEmails). */
  ownEmails: string[];
}

/**
 * The addresses that are "you" for reply recipients: every identity of your
 * own account, including one the merged list hides behind a group's copy. A
 * shared account's addresses are not yours: a colleague's mail from team@ is
 * not self-sent, and team@ stays in a reply-all unless you own it too.
 */
export function ownAccountEmails(accounts: SendableIdentities, ownAccountId: string): string[] {
  return (accounts[ownAccountId]?.identities ?? []).map((i) => i.email).filter(Boolean);
}

/**
 * The composer's identities from a load, or null to keep what is shown:
 * nothing loaded, or your own account is unknown or missing from the cache,
 * so no identity could be told apart as yours (each would get a routed id).
 */
export function composerIdentitySet(result: ComposerIdentities, ownAccountId: string | null): ComposerIdentitySet | null {
  if (result.source === 'none' || !ownAccountId) return null;
  if (result.source === 'cache' && !result.accounts[ownAccountId]) return null;
  return {
    ...buildSendIdentities(ownAccountId, result.accounts),
    ownAccountId,
    ownEmails: ownAccountEmails(result.accounts, ownAccountId),
  };
}

/**
 * The composer's identity load. The scope is taken inside the fetch: with no
 * connection yet (opened offline at cold start) taking it throws, and the
 * owner's cache must still stand in. Never rejects.
 */
export async function loadComposerSendIdentities(d: {
  appAccountId: string | null | undefined;
  /** Your own account for a cached list; null when unknown. */
  ownJmapAccountId: string | null;
  /** The account to fetch in ('' for the scope's own). */
  fetchAccountId: string;
  scope: () => OpScope;
  fetch: (at: OpScope) => Promise<SendableIdentities>;
  /** False once the app switched away from the owner during the fetch. */
  stillOwner?: () => boolean;
}): Promise<{ source: ComposerIdentities['source']; set: ComposerIdentitySet | null; error: string | null }> {
  const fresh: { own: string | null } = { own: null };
  const result = await loadComposerIdentities(d.appAccountId, d.ownJmapAccountId, async () => {
    const at = inAccount(d.scope(), d.fetchAccountId || undefined);
    fresh.own = at.accountId;
    const accounts = await d.fetch(at);
    if (d.stillOwner && !d.stillOwner()) throw new Error('Account switched');
    return accounts;
  });
  // A fresh list always holds the scope's own account; a cached one is only
  // read for a known own account.
  const set = composerIdentitySet(result, result.source === 'fresh' ? fresh.own : d.ownJmapAccountId);
  return { source: result.source, set, error: result.error };
}

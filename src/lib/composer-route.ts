// The composer's choices for a send from a shared account's identity, kept
// pure so they are tested without a renderer.

import type { ComposerIdentities } from './identity-cache';
import { RoutedSendError } from './routed-send';
import { buildSendIdentities, routeOfIdentity, type SendIdentity } from './send-identities';

/** The id a saved preference or template names, after the hidden-duplicate alias. */
export function resolveIdentityAlias(id: string | null | undefined, aliases: Record<string, string>): string | null {
  if (!id) return null;
  return aliases[id] ?? id;
}

/**
 * Identities eligible as the submission identity: only the chosen identity's
 * own account. Ids collide across accounts, so an override must never move a
 * send to an identity in another account.
 */
export function sameAccountIdentities(list: SendIdentity[], chosen: SendIdentity): SendIdentity[] {
  return list.filter((i) => i.jmapAccountId === chosen.jmapAccountId);
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

export interface ComposerIdentitySet {
  list: SendIdentity[];
  aliases: Record<string, string>;
  /** The account `list`'s own identities were read from. */
  ownAccountId: string;
}

/**
 * The composer's identities from a load, or null to keep what is shown:
 * nothing loaded, or your own account is unknown, so no identity could be
 * told apart as yours.
 */
export function composerIdentitySet(result: ComposerIdentities, ownAccountId: string | null): ComposerIdentitySet | null {
  if (result.source === 'none' || !ownAccountId) return null;
  return { ...buildSendIdentities(ownAccountId, result.accounts), ownAccountId };
}

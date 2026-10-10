/** Where a share sheet's principal list was asked for: app account and connection. */
export interface PrincipalsOrigin {
  appAccountId: string | null;
  /** `jmapClient.connectionGen` when the list was asked for. */
  gen: number;
}

/**
 * Whether a principal list asked for at `opened` may be shown, given what
 * holds `now`: the same app account still shown, on the same connection, and
 * the client serving it. In the switch window the client may still serve the
 * previous account, whose directory ids mean nothing on the shown one's server.
 */
export function principalsListUsable(
  opened: PrincipalsOrigin,
  now: PrincipalsOrigin & { served: boolean },
): boolean {
  return now.served && now.appAccountId === opened.appAccountId && now.gen === opened.gen;
}

/**
 * Why a share sheet has nobody to offer: the server listed no principals,
 * only the user's own (left out of the list), everyone else has a share
 * already (with nothing searched), or none matches the search.
 */
export function shareCandidatesEmptyReason(
  principals: readonly { id: string }[],
  selfId: string | null,
  shares: Readonly<Record<string, unknown>> = {},
  search = '',
): 'none' | 'only_self' | 'all_shared' | 'no_matches' {
  if (principals.length === 0) return 'none';
  const others = principals.filter((p) => p.id !== selfId);
  if (others.length === 0) return 'only_self';
  if (!search.trim() && others.every((p) => shares[p.id] != null)) return 'all_shared';
  return 'no_matches';
}

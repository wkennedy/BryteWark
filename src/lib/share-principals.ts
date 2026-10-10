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
 * only the user's own (left out of the list), or none matching the search
 * or not shared with already.
 */
export function shareCandidatesEmptyReason(
  principals: readonly { id: string }[],
  selfId: string | null,
): 'none' | 'only_self' | 'no_matches' {
  if (principals.length === 0) return 'none';
  return principals.every((p) => p.id === selfId) ? 'only_self' : 'no_matches';
}

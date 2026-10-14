import type { Email, Identity } from '../api/types';
import { getIdentities, type SendableIdentities } from '../api/identity';
import { resolveSendMailboxes } from '../api/sent-lookup';
import type { OpScope } from '../api/op-scope';
import { jmapClient } from '../api/jmap-client';
import { identitySendsAsOrSubaddress, routedIdentityId, type SendIdentity } from './send-identities';
import { resolveReplyFrom } from './reply-identity';

export type RoutedSendReason =
  | 'offline' | 'no_folders' | 'identity_gone' | 'from_override' | 'blob_copy' | 'no_group_identity';

/** A send from a shared account's identity that was refused before anything reached the server. */
export class RoutedSendError extends Error {
  constructor(public reason: RoutedSendReason, public address: string, public account: string) {
    super(`Routed send refused (${reason}) for ${address} in ${account}`);
    this.name = 'RoutedSendError';
  }
}

/**
 * The group-sender check, in the group's account `at`: its Sent and Drafts
 * exist, the identity is still there (re-read, never the cached copy), and
 * every address (`fromAddress`, the envelope senders) is the identity's own
 * or a sub-address of it. Reads only; refuses with `RoutedSendError` naming
 * `fromAddress` and `accountName`.
 */
export async function verifyGroupSender(
  at: OpScope,
  route: { jmapAccountId: string; identityId: string },
  addresses: (string | undefined)[],
  delimiter: string,
  accountName: string,
  fromAddress: string,
): Promise<{ sentId: string; draftsId: string; identity: Identity }> {
  const refuse = (reason: RoutedSendReason) => new RoutedSendError(reason, fromAddress, accountName);

  const { sentId, draftsId } = await resolveSendMailboxes(at);
  if (!sentId || !draftsId) throw refuse('no_folders');

  const identity = (await getIdentities(at)).find((i) => i.id === route.identityId);
  if (!identity) throw refuse('identity_gone');
  // Anything else is a custom From, which is never sent from a group (an id
  // could also name another address there).
  const covers = (a: string | undefined) => !a || identitySendsAsOrSubaddress(identity, a, delimiter);
  if (!fromAddress || !addresses.every(covers)) throw refuse('from_override');

  return { sentId, draftsId, identity };
}

const isWildcard = (i: Pick<Identity, 'email'>) => i.email.trim().startsWith('*@');

/**
 * A shared account's main identity: its first `!mayDelete` one, else its
 * first, never a catch-all (`*@…`), as the signature's primary pick.
 */
export function mainSendIdentity<T extends Pick<Identity, 'email' | 'mayDelete'>>(identities: T[]): T | undefined {
  const named = identities.filter((i) => !isWildcard(i));
  return named.find((i) => !i.mayDelete) ?? named[0];
}

/**
 * Who answers a message (unsubscribe mail, read receipt): `own` for mail in
 * your own account; for mail in a shared account, never you (your address
 * would show to the list) but `group`, that account's identity which received
 * it (To, Cc or Bcc; exact, then `+tag`), else its main identity; `refused`
 * when the account has none to send from (a folder-only share, or catch-alls
 * only), with its name for the alert.
 */
export type MessageAnswerer =
  | { kind: 'own' }
  | { kind: 'group'; identity: SendIdentity }
  | { kind: 'refused'; account: string };

/**
 * `MessageAnswerer` for a message in `messageJmapAccountId` (undefined: your
 * own). `ownAccountId` is the connected account (`connectedAccountId`):
 * unconnected, a message in another account is never taken for yours.
 */
export function messageAnswerer(p: {
  email: Pick<Email, 'to' | 'cc' | 'bcc'>;
  messageJmapAccountId: string | undefined;
  ownAccountId: string | null;
  sendAccounts: SendableIdentities;
}): MessageAnswerer {
  const at = p.messageJmapAccountId;
  if (!at || at === p.ownAccountId) return { kind: 'own' };
  const account = p.sendAccounts[at];
  const group: SendIdentity[] = (account?.identities ?? []).map((i) => ({
    ...i, id: routedIdentityId(at, i.id), jmapAccountId: at, accountName: account.name,
  }));
  const resolved = resolveReplyFrom(group, {
    to: p.email.to ?? undefined, cc: p.email.cc ?? undefined, bcc: p.email.bcc ?? undefined,
  });
  // A catch-all that received it gives no address to send as: the main one does.
  const received = resolved && !resolved.overrideEmail ? group.find((i) => i.id === resolved.identityId) : undefined;
  const identity = received && !isWildcard(received) ? received : mainSendIdentity(group);
  if (identity) return { kind: 'group', identity };
  return { kind: 'refused', account: account?.name ?? jmapClient.getAccountName(at) ?? at };
}

import type { Email, Identity } from '../api/types';
import { getIdentities, type SendableIdentities } from '../api/identity';
import { resolveSendMailboxes } from '../api/sent-lookup';
import type { OpScope } from '../api/op-scope';
import { buildSendIdentities, identitySendsAsOrSubaddress, type SendIdentity } from './send-identities';
import { resolveReplyFrom } from './reply-identity';

export type RoutedSendReason = 'offline' | 'no_folders' | 'identity_gone' | 'from_override' | 'blob_copy';

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

/**
 * The shared account's identity that received a message sitting in that
 * account (To, Cc or Bcc; exact, then `+tag`), which answers it for the
 * group. Undefined for mail in your own account, or when none of the
 * group's addresses received it: unlike `findReceivingIdentity` there is no
 * fall back, so the caller keeps its own-identity path.
 */
export function receivingSendIdentity(
  list: SendIdentity[],
  email: Pick<Email, 'to' | 'cc' | 'bcc'>,
  messageJmapAccountId: string | undefined,
  ownJmapAccountId: string,
): SendIdentity | undefined {
  if (!messageJmapAccountId || messageJmapAccountId === ownJmapAccountId) return undefined;
  const group = list.filter((i) => i.jmapAccountId === messageJmapAccountId);
  const resolved = resolveReplyFrom(group, {
    to: email.to ?? undefined, cc: email.cc ?? undefined, bcc: email.bcc ?? undefined,
  });
  if (!resolved || resolved.overrideEmail) return undefined;
  return group.find((i) => i.id === resolved.identityId);
}

/**
 * `receivingSendIdentity` over your own identities and each group's, built as
 * the quick reply builds them. `ownAccountId` is the connected account
 * (`connectedAccountId`): unconnected, only your own identities are known and
 * no group answers.
 */
export function groupReceiver(p: {
  email: Pick<Email, 'to' | 'cc' | 'bcc'>;
  messageJmapAccountId: string | undefined;
  ownAccountId: string | null;
  sendAccounts: SendableIdentities;
}): SendIdentity | undefined {
  const { ownAccountId, sendAccounts } = p;
  if (!ownAccountId || !sendAccounts[ownAccountId]) return undefined;
  const { list } = buildSendIdentities(ownAccountId, sendAccounts);
  return receivingSendIdentity(list, p.email, p.messageJmapAccountId, ownAccountId);
}

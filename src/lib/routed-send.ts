import { copyBlobs, BlobCopyError } from '../api/blob';
import { getIdentities } from '../api/identity';
import { resolveSendMailboxes } from '../api/sent-lookup';
import { sendEmail, type OutgoingEmail, type SendEmailResult } from '../api/email';
import { inAccount, type OpScope } from '../api/op-scope';
import { identitySendsAs } from './send-identities';

export type RoutedSendReason = 'offline' | 'no_folders' | 'identity_gone' | 'blob_copy';

/** A send from a shared account's identity that was refused before anything reached the server. */
export class RoutedSendError extends Error {
  constructor(public reason: RoutedSendReason, public address: string, public account: string) {
    super(`Routed send refused (${reason}) for ${address} in ${account}`);
    this.name = 'RoutedSendError';
  }
}

export interface RoutedSendParams {
  outgoing: OutgoingEmail;
  route: { jmapAccountId: string; identityId: string };
  accountName: string;
  /** Where `outgoing.attachments`' blobs live (your own account). */
  blobAccountId: string;
  holdForSeconds?: number;
  /** The previous draft, destroyed after the submit. */
  draftId?: string;
  /** Its account: your own, or the shared one it was opened from. */
  draftAccountId?: string;
  /** `opScope()` at send time; the routed scope is `inAccount(base, route.jmapAccountId)`. */
  base: OpScope;
}

/**
 * Sends as a group identity from the group's own account, so the copy files in
 * the group's Sent. The server doesn't check the header From against the
 * identity, so the client does, against the identity re-read from the group.
 * Nothing is created before the final send: every refusal leaves no server state.
 */
export async function sendRouted(p: RoutedSendParams): Promise<SendEmailResult & { accountId: string }> {
  const { outgoing, route, base } = p;
  const at = inAccount(base, route.jmapAccountId);
  const address = outgoing.from[0]?.email ?? '';
  const refuse = (reason: RoutedSendReason) => new RoutedSendError(reason, address, p.accountName);

  const { sentId, draftsId } = await resolveSendMailboxes(at);
  if (!sentId || !draftsId) throw refuse('no_folders');

  const identity = (await getIdentities(at)).find((i) => i.id === route.identityId);
  if (
    !identity ||
    !identitySendsAs(identity, address) ||
    (outgoing.envelopeMailFrom && !identitySendsAs(identity, outgoing.envelopeMailFrom))
  ) {
    throw refuse('identity_gone');
  }

  let copy = outgoing;
  const attachments = outgoing.attachments ?? [];
  if (attachments.length) {
    let moved: Record<string, string>;
    try {
      moved = await copyBlobs(p.blobAccountId, at, attachments.map((a) => a.blobId));
    } catch (e) {
      if (e instanceof BlobCopyError) throw refuse('blob_copy');
      throw e;
    }
    copy = { ...outgoing, attachments: attachments.map((a) => ({ ...a, blobId: moved[a.blobId] ?? a.blobId })) };
  }

  const result = await sendEmail(copy, route.identityId, sentId, p.holdForSeconds, {
    draftsMailboxId: draftsId,
    draftId: p.draftId,
    draftAccountId: p.draftAccountId ?? base.accountId,
    accountId: at,
  });
  return { ...result, accountId: route.jmapAccountId };
}

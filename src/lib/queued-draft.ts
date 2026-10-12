// Whether a queued send's `draftId` still names a draft, before anything
// destroys it. Rows queued before drafts were kept to their own account may
// carry a draft id from another account (a quick reply from a shared folder),
// and JMAP email ids repeat across accounts: in the row's account that id can
// name an ordinary message, which sending or saving would then destroy.

import { getEmailFlags } from '../api/email';
import { JMAPMethodError } from '../api/jmap-result';
import type { AccountRef } from '../api/op-scope';

/**
 * `draftId` when, in `account`, it is an email with `$draft` (and in the
 * Drafts folder `draftsId`, when the read gives its mailboxes); otherwise
 * undefined, so nothing is destroyed. A method error counts as "not a draft":
 * a leftover draft is harmless. Any other error (network, stale connection,
 * auth) rejects, for the caller to stop.
 */
export async function confirmedDraftId(
  draftId: string | undefined,
  account: AccountRef,
  draftsId: string | undefined,
): Promise<string | undefined> {
  if (!draftId) return undefined;
  let list: Awaited<ReturnType<typeof getEmailFlags>>['list'];
  try {
    ({ list } = await getEmailFlags([draftId], account));
  } catch (err) {
    if (err instanceof JMAPMethodError) return undefined;
    throw err;
  }
  const email = list.find((e) => e.id === draftId);
  if (email?.keywords?.$draft !== true) return undefined;
  if (email.mailboxIds && draftsId && email.mailboxIds[draftsId] !== true) return undefined;
  return draftId;
}

import type { ComposeDraftContext } from '../navigation/types';
import type { PendingUndoSend } from '../stores/send-undo-store';
import type { TranslateFn } from '../stores/locale-store';

export interface ReopenDeps {
  restore: () => Promise<ComposeDraftContext>;
  open: (draft: ComposeDraftContext) => void;
  alert: (title: string, message: string) => void;
  t: TranslateFn;
  /** The shared account's name for a group send; absent for your own. */
  accountName?: string;
}

/**
 * After an undo succeeded, bring the message back as a draft in the composer.
 * The undo itself is done, so a failure here is only reported: the message is
 * still in Sent and there is no retry.
 */
export async function reopenUndoneSend(_send: PendingUndoSend, deps: ReopenDeps): Promise<void> {
  const { restore, open, alert, t, accountName } = deps;
  try {
    open(await restore());
  } catch (err) {
    console.warn('[send-undo] reopen failed', err);
    const folder = accountName
      ? t('undo_send.sent_folder_group', "{account}'s Sent", { account: accountName })
      : t('undo_send.sent_folder', 'Sent');
    alert(
      t('undo_send.reopen_failed_title', 'Could not reopen message'),
      t('undo_send.reopen_failed', "Sending was cancelled, but the message couldn't be reopened. It is still in {folder}.", { folder }),
    );
  }
}

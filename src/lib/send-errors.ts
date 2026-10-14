import { RequestTimeoutError } from '../api/jmap-client';
import { isStaleLoad } from './network-error';
import {
  RecipientsRejectedError,
  SendUnconfirmedError,
  ScheduleTooLateError,
  formatRejectedRecipients,
} from '../api/jmap-result';
import { RoutedSendError } from './routed-send';

/** The alert a failed send shows, shared by the composer and quick reply. */
export function sendErrorAlert(
  e: unknown,
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string,
  // The account the message was started in, for a send an account switch stopped.
  opts: { account?: string } = {},
): { title: string; message: string } {
  if (isStaleLoad(e)) {
    // Nothing was sent: the app moved to another account first.
    return {
      title: t('email_composer.account_switched_title', 'Account changed'),
      message: t(
        'email_composer.account_switched_body',
        'This message was started in {account}. Switch back to it to send, save or attach files.',
        { account: opts.account ?? '' },
      ),
    };
  }
  if (e instanceof RecipientsRejectedError) {
    return {
      title: t('email_composer.send_recipients_rejected', 'Not sent - the server rejected every recipient.'),
      message: formatRejectedRecipients(e.recipients),
    };
  }
  if (e instanceof RoutedSendError) {
    const { address, account } = e;
    const title = t('email_composer.send_failed', 'Send failed');
    switch (e.reason) {
      case 'offline':
        return { title, message: t('email_composer.routed_offline', 'Connect to send from {address}.', { address, account }) };
      case 'no_folders':
        return {
          title,
          message: t(
            'email_composer.routed_no_folders',
            "{account} has no Sent or Drafts folder, so mail can't be sent from {address}.",
            { address, account },
          ),
        };
      case 'identity_gone':
        return {
          title,
          message: t('email_composer.routed_identity_gone', 'You can no longer send from {address} in {account}.', { address, account }),
        };
      case 'from_override':
        return {
          title,
          message: t(
            'email_composer.routed_from_override',
            "A custom From can't be used when sending from {account}.",
            { address, account },
          ),
        };
      case 'blob_copy':
        return {
          title,
          message: t(
            'email_composer.routed_blob_copy',
            "The attachments couldn't be copied to {account}. Nothing was sent.",
            { address, account },
          ),
        };
      case 'no_group_identity':
        return {
          title,
          message: t(
            'email_composer.routed_no_group_identity',
            "You can't send from {account}, so this can't be done here.",
            { account },
          ),
        };
    }
  }
  if (e instanceof RequestTimeoutError || e instanceof SendUnconfirmedError) {
    // The request may have reached the server; a blind retry would send the
    // message twice (#702).
    return {
      title: t('email_composer.send_timeout_title', 'No answer from the server'),
      message: t(
        'email_composer.send_timeout_body',
        'The message may already have gone out. Check your Sent folder before sending it again.',
      ),
    };
  }
  if (e instanceof ScheduleTooLateError) {
    // The server refused the hold; the pickers now only offer times within
    // the limit it named.
    return {
      title: t('email_composer.schedule_too_late_title', 'Too far ahead'),
      message: t('email_composer.schedule_too_late_body', 'That is later than this server allows. Pick an earlier time.'),
    };
  }
  return {
    title: t('email_composer.send_failed', 'Send failed'),
    message: e instanceof Error ? e.message : t('notifications.error_sending', 'Failed to send email'),
  };
}

/** Recipients the server accepted: a refused address is not someone to trust. */
export function withoutRefused<T extends { email: string }>(
  recipients: T[],
  refused: { email: string }[] | undefined,
): T[] {
  if (!refused?.length) return recipients;
  const gone = new Set(refused.map((r) => r.email.toLowerCase()));
  return recipients.filter((r) => !gone.has(r.email.toLowerCase()));
}

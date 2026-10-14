import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import { MailCheck } from 'lucide-react-native';
import type { Email } from '../../api/types';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useEmailStore, requireShownAccountScope, isShownAccount } from '../../stores/email-store';
import { inAccount, type OpScope } from '../../api/op-scope';
import { toast } from '../../stores/toast-store';
import { sendReadReceipt, patchKeywordsForEmails } from '../../api/email';
import { jmapClient } from '../../api/jmap-client';
import { findReceivingIdentity } from '../../lib/email-headers';
import { ownMailboxes } from '../../lib/mailbox-tree';
import { groupReceiver, verifyGroupSender, RoutedSendError } from '../../lib/group-sender';
import { routeOfIdentity } from '../../lib/send-identities';
import { sendErrorAlert } from '../../lib/send-errors';
import { useNetworkStore } from '../../stores/network-store';

interface Props {
  email: Email;
  /** Bare address from Disposition-Notification-To. */
  requestedBy: string;
  jmapAccountId?: string;
  /**
   * The app account the message is shown in (the viewer's). Defaults to the
   * one shown when the banner mounted.
   */
  appAccountId?: string;
  /** Role of the folder the message was opened from (receipts only in received folders). */
  currentMailboxRole?: string | null;
  /** The message is on screen, not in a neighbour page the pager pre-renders. */
  active: boolean;
  /** Reflect `$mdnsent` in the caller's cache. */
  onHandled: (email: Email) => void;
}

// Messages "always" mode has already tried to answer this session, keyed by
// account and id. One attempt each: a failed send is not retried, and a page
// the pager unmounts and mounts again does not send a second time.
const autoAttempted = new Set<string>();

/**
 * Read-receipt (MDN, RFC 8098) request banner: Send / Ignore, or auto-send
 * in "always" mode. Either answer flags the message `$mdnsent` (RFC 3503) so
 * the request is suppressed in every client, not just here. Never offered
 * for the user's own copies, trash or spam.
 */
export function ReadReceiptBanner({ email, requestedBy, jmapAccountId, appAccountId, currentMailboxRole, active, onHandled }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const identities = useSettingsStore((s) => s.identities);
  const sendAccounts = useSettingsStore((s) => s.sendAccounts);
  const ensureIdentities = useSettingsStore((s) => s.ensureIdentities);
  const readReceiptResponse = useSettingsStore((s) => s.readReceiptResponse);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const [busy, setBusy] = React.useState(false);
  const [handledLocally, setHandledLocally] = React.useState(false);
  // The app account this message was shown in. The identities and Sent folder
  // read here are the shown account's, and the receipt and `$mdnsent` name
  // the message by an id that repeats in other accounts, so both go out only
  // while that account is shown and served, on a scope taken then.
  const [mountedIn] = React.useState(() => useEmailStore.getState().activeAccountId);
  const ownerAppAccountId = appAccountId ?? mountedIn;

  React.useEffect(() => { setHandledLocally(false); }, [email.id]);
  // Held for the account after the first read, even when it has none.
  React.useEffect(() => { void ensureIdentities(); }, [ensureIdentities]);

  const eligibleFolder = !['sent', 'drafts', 'trash', 'junk', 'spam'].includes(currentMailboxRole || '');
  const identity = React.useMemo(() => findReceivingIdentity(identities, email), [identities, email]);
  const shouldOffer =
    !!requestedBy
    && !email.keywords?.$mdnsent
    && !email.keywords?.$draft
    && !handledLocally
    && readReceiptResponse !== 'never'
    && eligibleFolder
    && !!identity;

  const flagSent = React.useCallback(async (at?: OpScope) => {
    try {
      await patchKeywordsForEmails([email.id], { $mdnsent: true }, at ?? requireShownAccountScope(ownerAppAccountId, jmapAccountId));
    } catch { /* best effort - the local flag still hides the banner */ }
    onHandled({ ...email, keywords: { ...email.keywords, $mdnsent: true } });
  }, [email, jmapAccountId, ownerAppAccountId, onHandled]);

  // A group refusal says why in the composer's words.
  const failureMessage = React.useCallback((err: unknown) => (
    err instanceof RoutedSendError ? sendErrorAlert(err, t).message : err instanceof Error ? err.message : String(err)
  ), [t]);

  const send = React.useCallback(async (automatic: boolean) => {
    if (!identity) return;
    // A message one of a group's addresses received is answered from that
    // group, into its Sent, after the group-sender check; refused rather than
    // sent from your own address. `connectedAccountId`, not `accountId`
    // (which throws before a connection).
    const group = groupReceiver({
      email, messageJmapAccountId: jmapAccountId, ownAccountId: jmapClient.connectedAccountId, sendAccounts,
    });
    // A group send never queues: offline it is refused.
    if (group && (!useNetworkStore.getState().online || !jmapClient.isConnected)) {
      throw new RoutedSendError('offline', group.email, group.accountName);
    }
    // Never from another account's identity: refused once another is shown.
    // `$mdnsent` is set in the message's account, on the same connection.
    const base = requireShownAccountScope(ownerAppAccountId);
    let sender: { email: string; name?: string };
    let submit: { at: OpScope; identityId: string; sentMailboxId: string };
    if (group) {
      const route = routeOfIdentity(group);
      const at = inAccount(base, route.jmapAccountId);
      const { sentId } = await verifyGroupSender(at, route, [group.email], '+', group.accountName, group.email);
      sender = group;
      submit = { at, identityId: route.identityId, sentMailboxId: sentId };
    } else {
      // Sent of the account the receipt is submitted from: the user's own.
      const sent = ownMailboxes(mailboxes).find((m) => m.role === 'sent');
      if (!sent) throw new Error(t('email_composer.no_sent_folder', 'No Sent folder found'));
      sender = identity;
      submit = { at: base, identityId: identity.id, sentMailboxId: sent.originalId ?? sent.id };
    }
    await sendReadReceipt({
      to: requestedBy,
      fromEmail: sender.email,
      fromName: sender.name,
      identityId: submit.identityId,
      sentMailboxId: submit.sentMailboxId,
      accountId: submit.at,
      originalMessageId: email.messageId,
      originalSubject: email.subject,
      originalRecipient: sender.email,
      automatic,
      subject: t('email_viewer.read_receipt.mdn_subject', 'Read: {subject}', { subject: email.subject || '' }),
      humanText: t(
        'email_viewer.read_receipt.mdn_body',
        "This is a return receipt for the message you sent to {recipient}.\n\nNote: This receipt only acknowledges that the message was displayed on the recipient's device. There is no guarantee that the recipient has read or understood the message contents.",
        { recipient: sender.email },
      ),
    });
    await flagSent(inAccount(base, jmapAccountId));
  }, [identity, email, sendAccounts, mailboxes, requestedBy, jmapAccountId, ownerAppAccountId, t, flagSent]);

  // "always" mode: auto-send once when the message is actually displayed.
  React.useEffect(() => {
    if (readReceiptResponse !== 'always' || !shouldOffer || !active || !isShownAccount(ownerAppAccountId)) return;
    // Not `accountId`: a message opened from a notification can render before
    // the client connects. Without an account there is nothing to send yet.
    const account = jmapAccountId ?? jmapClient.connectedAccountId;
    if (!account) return;
    const key = `${account}:${email.id}`;
    if (autoAttempted.has(key)) return;
    autoAttempted.add(key);
    setHandledLocally(true);
    send(true).catch((err) => {
      console.warn('[mdn] auto-send failed', err);
      // Not retried, so say so rather than fail silently (webmail parity).
      toast.error(t('email_viewer.read_receipt.send_failed', 'Read receipt could not be sent'), failureMessage(err));
    });
  }, [readReceiptResponse, shouldOffer, active, ownerAppAccountId, jmapAccountId, email.id, send, t, failureMessage]);

  if (!shouldOffer || readReceiptResponse === 'always') return null;

  const onSend = async () => {
    setBusy(true);
    try {
      await send(false);
      setHandledLocally(true);
    } catch (err) {
      Alert.alert(t('email_viewer.read_receipt.send_failed', 'Read receipt could not be sent'), failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onIgnore = async () => {
    setHandledLocally(true);
    await flagSent();
  };

  return (
    <View style={styles.banner}>
      <MailCheck size={16} color={c.textSecondary} />
      <Text style={styles.text}>{t('email_viewer.read_receipt.prompt', 'The sender asked to be notified when you open this message.')}</Text>
      {busy ? (
        <ActivityIndicator size="small" color={c.primary} />
      ) : (
        <View style={styles.actions}>
          <Pressable onPress={onSend} hitSlop={8}>
            <Text style={styles.primary}>{t('email_viewer.read_receipt.send', 'Send receipt')}</Text>
          </Pressable>
          <Pressable onPress={onIgnore} hitSlop={8}>
            <Text style={styles.secondary}>{t('email_viewer.read_receipt.ignore', 'Ignore')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.surfaceHover,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    text: { ...typography.caption, color: c.textSecondary, flex: 1, minWidth: 160 },
    actions: { flexDirection: 'row', gap: spacing.md },
    primary: { ...typography.caption, color: c.primary, fontWeight: '600' },
    secondary: { ...typography.caption, color: c.textMuted, fontWeight: '600' },
  });
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Email, Mailbox } from '../../../api/types';

vi.mock('react-native', () => ({
  NativeModules: {}, Linking: { openURL: async () => undefined },
  NativeEventEmitter: class { addListener() { return { remove: () => undefined }; } removeAllListeners() {} },
  Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => undefined }) },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (s: unknown) => s },
  Alert: { alert: vi.fn() },
  Platform: { OS: 'android', select: (s: any) => s.android ?? s.default },
}));
vi.mock('lucide-react-native', () => ({
  MailMinus: 'MailMinus', CheckCircle2: 'CheckCircle2', AlertCircle: 'AlertCircle', X: 'X', MailCheck: 'MailCheck',
}));
vi.mock('../../../theme/colors', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }));
vi.mock('../../../api/email', () => ({
  sendEmail: vi.fn(async () => ({})),
  sendReadReceipt: vi.fn(async () => undefined),
  patchKeywordsForEmails: vi.fn(async () => undefined),
}));
const resolveSendMailboxes = vi.fn();
const getIdentities = vi.fn();
vi.mock('../../../api/sent-lookup', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSendMailboxes: (...a: unknown[]) => resolveSendMailboxes(...a),
}));
vi.mock('../../../api/identity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getIdentities: (...a: unknown[]) => getIdentities(...a),
}));
vi.mock('../../../lib/active-client-account', () => ({
  clientServesAccount: () => true,
  recordedJmapAccountId: () => undefined,
}));

import { Alert } from 'react-native';
import { UnsubscribeBanner } from '../UnsubscribeBanner';
import { ReadReceiptBanner } from '../ReadReceiptBanner';
import { renderComponent, findElement, resetHooks } from './hook-harness';
import { sendEmail, sendReadReceipt, patchKeywordsForEmails } from '../../../api/email';
import { jmapClient } from '../../../api/jmap-client';
import { useEmailStore } from '../../../stores/email-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { useNetworkStore } from '../../../stores/network-store';
import { toast } from '../../../stores/toast-store';

const mb = (over: Partial<Mailbox>): Mailbox => ({
  id: 'x', name: 'x', totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  myRights: {} as Mailbox['myRights'], ...over,
});
const mailboxes: Mailbox[] = [
  mb({ id: 'own-sent', role: 'sent' }),
  mb({ id: 'own-drafts', role: 'drafts' }),
  mb({ id: 'f:sent', originalId: 'shared-sent', role: 'sent', isShared: true, accountId: 'f' }),
  mb({ id: 'f:drafts', originalId: 'shared-drafts', role: 'drafts', isShared: true, accountId: 'f' }),
];
// In the shared account `f`, addressed only to you (a list copy in the group folder).
const email = {
  id: 'm1', subject: 'Hi', messageId: '<m@x>', from: [{ email: 'news@x' }], to: [{ email: 'bob@x' }], keywords: {},
} as unknown as Email;
// In `f`, received by the group's address team@x.
const groupEmail = { ...email, id: 'm-team', to: [{ email: 'team@x' }] } as unknown as Email;
const bob = { id: 'b', name: 'Bob', email: 'bob@x', mayDelete: false };
const team = { id: 't', name: 'Team', email: 'team@x', mayDelete: false };
// In `f`, sent to an alias on the group's domain that only its catch-all covers.
const aliasEmail = { ...email, id: 'm-alias', to: [{ email: 'hello@x' }] } as unknown as Email;
const catchAll = { id: 'w', name: 'Any', email: '*@x', mayDelete: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(jmapClient, 'accountId', 'get').mockReturnValue('c');
  vi.spyOn(jmapClient, 'connectedAccountId', 'get').mockReturnValue('c');
  vi.spyOn(jmapClient, 'connectionGen', 'get').mockReturnValue(1);
  vi.spyOn(jmapClient, 'isConnected', 'get').mockReturnValue(true);
  useEmailStore.setState({ mailboxes, activeAccountId: 'app1' } as never);
  useNetworkStore.setState({ online: true } as never);
  useSettingsStore.setState({
    identities: [bob],
    sendAccounts: { c: { name: 'Bob', identities: [bob] }, f: { name: 'Team', identities: [team] } },
    readReceiptResponse: 'ask',
  } as never);
  // The group's own folders, read from its account.
  resolveSendMailboxes.mockResolvedValue({ sentId: 'g-sent', draftsId: 'g-drafts' });
  getIdentities.mockResolvedValue([team]);
});

afterEach(() => resetHooks());

describe('UnsubscribeBanner mailto on a shared-account message', () => {
  const list = { listUnsubscribe: { preferred: 'mailto', mailto: 'mailto:unsub@news.example' } } as never;
  const confirmUnsubscribe = async (appAccountId: string, message: Email = email, jmapAccountId = 'f') => {
    const view = renderComponent(UnsubscribeBanner, {
      email: message, list, messageKey: 'k1', jmapAccountId, appAccountId,
    }, { effects: true });
    await new Promise((r) => setTimeout(r, 0));
    // The unsubscribe button: the one pressable that is not the labelled dismiss.
    findElement(view.tree(), (p) => typeof p.onPress === 'function' && p.hitSlop === 8 && !p.accessibilityLabel)!.props.onPress();
    const buttons = vi.mocked(Alert.alert).mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    buttons.find((b) => b.onPress)!.onPress!();
    await new Promise((r) => setTimeout(r, 0));
  };

  it('is refused once another account is shown', async () => {
    await confirmUnsubscribe('app2');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends from the own account with the own Sent and Drafts for mail in your own account', async () => {
    await confirmUnsubscribe('app1', email, 'c');
    const [outgoing, identityId, sentId, , opts] = vi.mocked(sendEmail).mock.calls[0] as any[];
    expect(outgoing.from).toEqual([{ name: 'Bob', email: 'bob@x' }]);
    expect(identityId).toBe('b');
    expect(sentId).toBe('own-sent');
    expect(opts.draftsMailboxId).toBe('own-drafts');
    expect(opts.accountId.accountId).toBe('c');
    expect(resolveSendMailboxes).not.toHaveBeenCalled();
  });

  it('sends a list copy in the group folder from the group main identity, never yours', async () => {
    await confirmUnsubscribe('app1');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [outgoing, identityId, sentId, , opts] = vi.mocked(sendEmail).mock.calls[0] as any[];
    expect(outgoing.from).toEqual([{ name: 'Team', email: 'team@x' }]);
    expect(identityId).toBe('t');
    expect(sentId).toBe('g-sent');
    expect(opts.draftsMailboxId).toBe('g-drafts');
    expect(opts.accountId).toEqual({ gen: 1, accountId: 'f' });
    expect(getIdentities).toHaveBeenCalledWith({ gen: 1, accountId: 'f' });
  });

  it('answers mail a group catch-all received from the main non-wildcard identity', async () => {
    useSettingsStore.setState({
      sendAccounts: { c: { name: 'Bob', identities: [bob] }, f: { name: 'Team', identities: [catchAll, team] } },
    } as never);
    getIdentities.mockResolvedValue([catchAll, team]);
    await confirmUnsubscribe('app1', aliasEmail);
    const [outgoing, identityId, sentId, , opts] = vi.mocked(sendEmail).mock.calls[0] as any[];
    expect(outgoing.from).toEqual([{ name: 'Team', email: 'team@x' }]);
    expect(identityId).toBe('t');
    expect(sentId).toBe('g-sent');
    expect(opts.accountId).toEqual({ gen: 1, accountId: 'f' });
  });

  it('is refused for a share you cannot send from, never sent from your own account', async () => {
    vi.spyOn(jmapClient, 'getAccountName').mockImplementation((id) => (id === 'h' ? 'Projects' : undefined));
    await confirmUnsubscribe('app1', email, 'h');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(resolveSendMailboxes).not.toHaveBeenCalled();
    expect(vi.mocked(Alert.alert).mock.calls[1][1]).toBe("You can't send from Projects, so this can't be done here.");
  });

  it('sends from the group that received it, into the group Sent', async () => {
    await confirmUnsubscribe('app1', groupEmail);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [outgoing, identityId, sentId, , opts] = vi.mocked(sendEmail).mock.calls[0] as any[];
    expect(outgoing.from).toEqual([{ name: 'Team', email: 'team@x' }]);
    expect(outgoing.to).toEqual([{ email: 'unsub@news.example' }]);
    expect(identityId).toBe('t');
    expect(sentId).toBe('g-sent');
    expect(opts.draftsMailboxId).toBe('g-drafts');
    expect(opts.accountId).toEqual({ gen: 1, accountId: 'f' });
    expect(opts.draftAccountId).toBe('c');
    expect(resolveSendMailboxes).toHaveBeenCalledWith({ gen: 1, accountId: 'f' });
    expect(getIdentities).toHaveBeenCalledWith({ gen: 1, accountId: 'f' });
  });

  it('is refused offline, never sent from your own account', async () => {
    useNetworkStore.setState({ online: false } as never);
    await confirmUnsubscribe('app1', groupEmail);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(resolveSendMailboxes).not.toHaveBeenCalled();
    expect(vi.mocked(Alert.alert).mock.calls[1][1]).toBe('Connect to send from team@x.');
  });

  it('is refused when the group has no Sent, never sent from your own account', async () => {
    resolveSendMailboxes.mockResolvedValue({ draftsId: 'g-drafts' });
    await confirmUnsubscribe('app1', groupEmail);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(vi.mocked(Alert.alert).mock.calls[1][1])
      .toBe("Team has no Sent or Drafts folder, so mail can't be sent from team@x.");
  });
});

describe('ReadReceiptBanner on a shared-account message', () => {
  const sendReceipt = async (message: Email = email, jmapAccountId = 'f') => {
    const view = renderComponent(ReadReceiptBanner, {
      email: message, requestedBy: 'news@x', jmapAccountId, appAccountId: 'app1', currentMailboxRole: 'inbox',
      active: true, onHandled: vi.fn(),
    });
    await findElement(view.tree(), (p) => typeof p.onPress === 'function' && p.hitSlop === 8)!.props.onPress();
  };

  it('submits the receipt from the group that received it, into the group Sent', async () => {
    await sendReceipt(groupEmail);
    expect(sendReadReceipt).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendReadReceipt).mock.calls[0][0] as any;
    expect(arg.accountId).toEqual({ gen: 1, accountId: 'f' });
    expect(arg.sentMailboxId).toBe('g-sent');
    expect(arg.identityId).toBe('t');
    expect(arg.fromEmail).toBe('team@x');
    expect(arg.originalRecipient).toBe('team@x');
    expect(getIdentities).toHaveBeenCalledWith({ gen: 1, accountId: 'f' });
    const [ids, keywords, scope] = vi.mocked(patchKeywordsForEmails).mock.calls[0] as any[];
    expect(ids).toEqual(['m-team']);
    expect(keywords).toEqual({ $mdnsent: true });
    expect(scope).toEqual({ gen: 1, accountId: 'f' });
  });

  it('is refused offline, never submitted from your own account', async () => {
    useNetworkStore.setState({ online: false } as never);
    await sendReceipt(groupEmail);
    expect(sendReadReceipt).not.toHaveBeenCalled();
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(vi.mocked(Alert.alert).mock.calls[0][1]).toBe('Connect to send from team@x.');
  });

  it('is refused when the group has no Sent, never submitted from your own account', async () => {
    resolveSendMailboxes.mockResolvedValue({ draftsId: 'g-drafts' });
    await sendReceipt(groupEmail);
    expect(sendReadReceipt).not.toHaveBeenCalled();
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(vi.mocked(Alert.alert).mock.calls[0][1])
      .toBe("Team has no Sent or Drafts folder, so mail can't be sent from team@x.");
  });

  it('is refused when the identity is gone from the group', async () => {
    getIdentities.mockResolvedValue([]);
    await sendReceipt(groupEmail);
    expect(sendReadReceipt).not.toHaveBeenCalled();
    expect(vi.mocked(Alert.alert).mock.calls[0][1]).toBe('You can no longer send from team@x in Team.');
  });

  it('submits the receipt from the group main identity when no group address received it, never yours', async () => {
    await sendReceipt();
    const arg = vi.mocked(sendReadReceipt).mock.calls[0][0] as any;
    expect(arg.accountId).toEqual({ gen: 1, accountId: 'f' });
    expect(arg.sentMailboxId).toBe('g-sent');
    expect(arg.identityId).toBe('t');
    expect(arg.fromEmail).toBe('team@x');
    expect(arg.originalRecipient).toBe('team@x');
    expect(arg.humanText).toContain('you sent to team@x.');
    const [ids, keywords, scope] = vi.mocked(patchKeywordsForEmails).mock.calls[0] as any[];
    expect(ids).toEqual(['m1']);
    expect(keywords).toEqual({ $mdnsent: true });
    expect(scope).toEqual({ gen: 1, accountId: 'f' });
  });

  it('submits the receipt from the main non-wildcard identity for mail a group catch-all received', async () => {
    useSettingsStore.setState({
      sendAccounts: { c: { name: 'Bob', identities: [bob] }, f: { name: 'Team', identities: [catchAll, team] } },
    } as never);
    getIdentities.mockResolvedValue([catchAll, team]);
    await sendReceipt(aliasEmail);
    const arg = vi.mocked(sendReadReceipt).mock.calls[0][0] as any;
    expect(arg.accountId).toEqual({ gen: 1, accountId: 'f' });
    expect(arg.identityId).toBe('t');
    expect(arg.fromEmail).toBe('team@x');
  });

  it('submits the receipt from the own account for mail in your own account', async () => {
    await sendReceipt(email, 'c');
    expect(resolveSendMailboxes).not.toHaveBeenCalled();
    const arg = vi.mocked(sendReadReceipt).mock.calls[0][0] as any;
    expect(arg.accountId.accountId).toBe('c');
    expect(arg.sentMailboxId).toBe('own-sent');
    expect(arg.identityId).toBe('b');
    expect(arg.fromEmail).toBe('bob@x');
    const [ids, , scope] = vi.mocked(patchKeywordsForEmails).mock.calls[0] as any[];
    expect(ids).toEqual(['m1']);
    expect(scope.accountId).toBe('c');
  });

  it('is not offered for a share you cannot send from', () => {
    const view = renderComponent(ReadReceiptBanner, {
      email, requestedBy: 'news@x', jmapAccountId: 'h', appAccountId: 'app1', currentMailboxRole: 'inbox',
      active: true, onHandled: vi.fn(),
    });
    expect(view.tree()).toBeNull();
  });
});

describe('ReadReceiptBanner in "always" mode on a shared-account message', () => {
  it('submits the receipt automatically from the own account for mail in your own account', async () => {
    useSettingsStore.setState({ readReceiptResponse: 'always', ensureIdentities: vi.fn(async () => undefined) } as never);
    renderComponent(ReadReceiptBanner, {
      email: { ...email, id: 'm-auto' } as Email, requestedBy: 'news@x', jmapAccountId: undefined, appAccountId: 'app1',
      currentMailboxRole: 'inbox', active: true, onHandled: vi.fn(),
    }, { effects: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(sendReadReceipt).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendReadReceipt).mock.calls[0][0] as any;
    expect(arg.automatic).toBe(true);
    expect(arg.accountId.accountId).toBe('c');
    expect(arg.sentMailboxId).toBe('own-sent');
    expect(arg.identityId).toBe('b');
    const [ids, keywords, scope] = vi.mocked(patchKeywordsForEmails).mock.calls[0] as any[];
    expect(ids).toEqual(['m-auto']);
    expect(keywords).toEqual({ $mdnsent: true });
    expect(scope.accountId).toBe('c');
  });

  const autoSend = async (message: Email, jmapAccountId = 'f') => {
    useSettingsStore.setState({ readReceiptResponse: 'always', ensureIdentities: vi.fn(async () => undefined) } as never);
    renderComponent(ReadReceiptBanner, {
      email: message, requestedBy: 'news@x', jmapAccountId, appAccountId: 'app1',
      currentMailboxRole: 'inbox', active: true, onHandled: vi.fn(),
    }, { effects: true });
    await new Promise((r) => setTimeout(r, 0));
  };

  it('submits the receipt automatically from the group that received it', async () => {
    await autoSend({ ...groupEmail, id: 'm-auto-team' } as Email);
    expect(sendReadReceipt).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendReadReceipt).mock.calls[0][0] as any;
    expect(arg.automatic).toBe(true);
    expect(arg.accountId).toEqual({ gen: 1, accountId: 'f' });
    expect(arg.sentMailboxId).toBe('g-sent');
    expect(arg.identityId).toBe('t');
    expect(arg.fromEmail).toBe('team@x');
    expect(arg.originalRecipient).toBe('team@x');
  });

  it('refuses offline with a toast, as a failed automatic send does, never from your own account', async () => {
    useNetworkStore.setState({ online: false } as never);
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
    await autoSend({ ...groupEmail, id: 'm-auto-offline' } as Email);
    expect(sendReadReceipt).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Read receipt could not be sent', 'Connect to send from team@x.');
  });

  it('submits the receipt automatically from the group main identity when no group address received it', async () => {
    await autoSend({ ...email, id: 'm-auto-main' } as Email);
    const arg = vi.mocked(sendReadReceipt).mock.calls[0][0] as any;
    expect(arg.automatic).toBe(true);
    expect(arg.accountId).toEqual({ gen: 1, accountId: 'f' });
    expect(arg.identityId).toBe('t');
    expect(arg.fromEmail).toBe('team@x');
  });

  it('sends nothing automatically for a share you cannot send from', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
    await autoSend({ ...email, id: 'm-auto-none' } as Email, 'h');
    expect(sendReadReceipt).not.toHaveBeenCalled();
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

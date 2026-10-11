import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('../../../lib/active-client-account', () => ({
  clientServesAccount: () => true,
  recordedJmapAccountId: () => undefined,
}));

import { Alert } from 'react-native';
import { UnsubscribeBanner } from '../UnsubscribeBanner';
import { ReadReceiptBanner } from '../ReadReceiptBanner';
import { renderComponent, findElement } from './hook-harness';
import { sendEmail, sendReadReceipt, patchKeywordsForEmails } from '../../../api/email';
import { jmapClient } from '../../../api/jmap-client';
import { useEmailStore } from '../../../stores/email-store';
import { useSettingsStore } from '../../../stores/settings-store';

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
const email = {
  id: 'm1', subject: 'Hi', messageId: '<m@x>', from: [{ email: 'news@x' }], to: [{ email: 'bob@x' }], keywords: {},
} as unknown as Email;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(jmapClient, 'accountId', 'get').mockReturnValue('c');
  vi.spyOn(jmapClient, 'connectedAccountId', 'get').mockReturnValue('c');
  vi.spyOn(jmapClient, 'connectionGen', 'get').mockReturnValue(1);
  vi.spyOn(jmapClient, 'isConnected', 'get').mockReturnValue(true);
  useEmailStore.setState({ mailboxes, activeAccountId: 'app1' } as never);
  useSettingsStore.setState({
    identities: [{ id: 'b', name: 'Bob', email: 'bob@x', mayDelete: false }],
    readReceiptResponse: 'ask',
  } as never);
});

describe('UnsubscribeBanner mailto on a shared-account message', () => {
  const list = { listUnsubscribe: { preferred: 'mailto', mailto: 'mailto:unsub@news.example' } } as never;
  const confirmUnsubscribe = async (appAccountId: string) => {
    const view = renderComponent(UnsubscribeBanner, { email, list, messageKey: 'k1', appAccountId }, { effects: true });
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

  it('sends from the own account with the own Sent and Drafts', async () => {
    await confirmUnsubscribe('app1');
    const [, identityId, sentId, , opts] = vi.mocked(sendEmail).mock.calls[0] as any[];
    expect(identityId).toBe('b');
    expect(sentId).toBe('own-sent');
    expect(opts.draftsMailboxId).toBe('own-drafts');
    expect(opts.accountId.accountId).toBe('c');
  });
});

describe('ReadReceiptBanner on a shared-account message', () => {
  it('submits the receipt from the own account and flags $mdnsent in the message account', async () => {
    const view = renderComponent(ReadReceiptBanner, {
      email, requestedBy: 'news@x', jmapAccountId: 'f', appAccountId: 'app1', currentMailboxRole: 'inbox',
      active: true, onHandled: vi.fn(),
    });
    await findElement(view.tree(), (p) => typeof p.onPress === 'function' && p.hitSlop === 8)!.props.onPress();
    const arg = vi.mocked(sendReadReceipt).mock.calls[0][0] as any;
    expect(arg.accountId.accountId).toBe('c');
    expect(arg.sentMailboxId).toBe('own-sent');
    expect(arg.identityId).toBe('b');
    const [ids, keywords, scope] = vi.mocked(patchKeywordsForEmails).mock.calls[0] as any[];
    expect(ids).toEqual(['m1']);
    expect(keywords).toEqual({ $mdnsent: true });
    expect(scope.accountId).toBe('f');
    expect(scope.gen).toBe(arg.accountId.gen);
  });
});

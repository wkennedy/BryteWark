import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '../../../api/types';

vi.mock('react-native', () => ({
  NativeModules: {}, Linking: { openURL: async () => undefined },
  NativeEventEmitter: class { addListener() { return { remove: () => undefined }; } removeAllListeners() {} },
  Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => undefined }) },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (s: unknown) => s },
  Alert: { alert: vi.fn() },
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'android', select: (s: any) => s.android ?? s.default },
}));
vi.mock('lucide-react-native', () => ({ Send: 'Send', Maximize2: 'Maximize2' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('../../../theme/colors', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }));
vi.mock('../../../lib/use-date-region', () => ({ useDateRegion: () => 'US' }));
vi.mock('../../../api/email', () => ({
  sendEmail: vi.fn(async () => ({ emailId: 'e1', emailSubmissionId: 's1', scheduled: true })),
  patchKeywordsForEmails: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/active-client-account', () => ({
  clientServesAccount: () => true,
  recordedJmapAccountId: () => undefined,
}));
vi.mock('../../../lib/queue-send', async (orig) => ({
  ...(await orig<typeof import('../../../lib/queue-send')>()),
  findAlreadyQueued: vi.fn(async () => null),
  quickReplyOwnerActive: () => true,
}));

import { QuickReplyBox } from '../QuickReplyBox';
import { renderComponent, findElement } from './hook-harness';
import { sendEmail, patchKeywordsForEmails } from '../../../api/email';
import { jmapClient } from '../../../api/jmap-client';
import { useEmailStore } from '../../../stores/email-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { useSendUndoStore } from '../../../stores/send-undo-store';
import { useSendQueueStore } from '../../../stores/send-queue-store';
import { useNetworkStore } from '../../../stores/network-store';

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
  id: 'm1', subject: 'Hi', from: [{ email: 'alice@x' }], to: [{ email: 'bob@x' }], keywords: {},
} as unknown as Email;

async function pressSend() {
  const view = renderComponent(QuickReplyBox, { email, jmapAccountId: 'f', ownerAppAccountId: 'app1', onMoreOptions: vi.fn() });
  findElement(view.tree(), (p) => 'onChangeText' in p)!.props.onChangeText('thanks');
  await findElement(view.tree(), (p) => typeof p.onPress === 'function' && p.disabled === false)!.props.onPress();
}

describe('QuickReplyBox on a shared-account message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(jmapClient, 'accountId', 'get').mockReturnValue('c');
    vi.spyOn(jmapClient, 'connectedAccountId', 'get').mockReturnValue('c');
    vi.spyOn(jmapClient, 'connectionGen', 'get').mockReturnValue(1);
    vi.spyOn(jmapClient, 'undoSendHold').mockReturnValue(30);
    useEmailStore.setState({ mailboxes, activeAccountId: 'app1' } as never);
    useSettingsStore.setState({ identities: [{ id: 'b', name: 'Bob', email: 'bob@x', mayDelete: false }], sendDelaySeconds: 30 } as never);
    useNetworkStore.setState({ online: true } as never);
  });

  it('submits from the own account with own Sent/Drafts and flags in the message account', async () => {
    await pressSend();
    const [, identityId, sentId, , opts] = vi.mocked(sendEmail).mock.calls[0] as any[];
    expect(identityId).toBe('b');
    expect(sentId).toBe('own-sent');
    expect(opts.draftsMailboxId).toBe('own-drafts');
    expect(opts.accountId.accountId).toBe('c');
    expect(jmapClient.undoSendHold).toHaveBeenCalledWith(30, 'c');
    const [ids, keywords, scope] = vi.mocked(patchKeywordsForEmails).mock.calls[0] as any[];
    expect(ids).toEqual(['m1']);
    expect(keywords).toEqual({ $answered: true });
    expect(scope.accountId).toBe('f');
    expect(scope.gen).toBe(opts.accountId.gen);
    expect(useSendUndoStore.getState().pending?.accountId).toBe('c');
  });

  it('queues offline against the own account, replying to the message account', async () => {
    useNetworkStore.setState({ online: false } as never);
    const original = useSendQueueStore.getState().enqueue;
    const enqueue = vi.fn(async (_row: unknown) => undefined);
    useSendQueueStore.setState({ enqueue } as never);
    try {
      await pressSend();
    } finally {
      useSendQueueStore.setState({ enqueue: original } as never);
    }
    const row = enqueue.mock.calls[0][0] as any;
    expect(row.jmapAccountId).toBe('c');
    expect(row.replyTo.jmapAccountId).toBe('f');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('../../../lib/routed-send', async (orig) => ({
  ...(await orig<typeof import('../../../lib/routed-send')>()),
  sendRouted: vi.fn(async () => ({ emailId: 'e2', emailSubmissionId: 's2', scheduled: true, accountId: 'f' })),
}));
vi.mock('../../../lib/active-client-account', () => ({
  clientServesAccount: () => true,
  recordedJmapAccountId: vi.fn((): string | undefined => undefined),
}));
vi.mock('../../../lib/queue-send', async (orig) => ({
  ...(await orig<typeof import('../../../lib/queue-send')>()),
  findAlreadyQueued: vi.fn(async () => null),
  quickReplyOwnerActive: () => true,
}));

import { QuickReplyBox } from '../QuickReplyBox';
import { renderComponent, findElement, resetHooks } from './hook-harness';
import { sendEmail, patchKeywordsForEmails } from '../../../api/email';
import { sendRouted } from '../../../lib/routed-send';
import { Alert } from 'react-native';
import { recordedJmapAccountId } from '../../../lib/active-client-account';
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

// No default parameter: `undefined` is a case of its own (an own-account message).
async function pressSend(...args: [jmapAccountId?: string]) {
  const jmapAccountId = args.length ? args[0] : 'f';
  const view = renderComponent(QuickReplyBox, { email, jmapAccountId, ownerAppAccountId: 'app1', onMoreOptions: vi.fn() });
  findElement(view.tree(), (p) => 'onChangeText' in p)!.props.onChangeText('thanks');
  await findElement(view.tree(), (p) => typeof p.onPress === 'function' && p.disabled === false)!.props.onPress();
}

afterEach(() => resetHooks());

/** Press Send offline, capturing the row instead of storing it. */
async function queueOffline(jmapAccountId: string | undefined) {
  useNetworkStore.setState({ online: false } as never);
  const original = useSendQueueStore.getState().enqueue;
  const enqueue = vi.fn(async (_row: unknown) => undefined);
  useSendQueueStore.setState({ enqueue } as never);
  try {
    await pressSend(jmapAccountId);
  } finally {
    useSendQueueStore.setState({ enqueue: original } as never);
  }
  return enqueue.mock.calls[0][0] as any;
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
    const row = await queueOffline('f');
    expect(row.jmapAccountId).toBe('c');
    expect(row.replyTo.jmapAccountId).toBe('f');
  });
});

describe('QuickReplyBox on an own-account message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(jmapClient, 'accountId', 'get').mockReturnValue('c');
    vi.spyOn(jmapClient, 'connectedAccountId', 'get').mockReturnValue('c');
    vi.spyOn(jmapClient, 'connectionGen', 'get').mockReturnValue(1);
    vi.spyOn(jmapClient, 'undoSendHold').mockReturnValue(30);
    useEmailStore.setState({ mailboxes, activeAccountId: 'app1' } as never);
    useSettingsStore.setState({ identities: [{ id: 'b', name: 'Bob', email: 'bob@x', mayDelete: false }], sendDelaySeconds: 30 } as never);
    useNetworkStore.setState({ online: true } as never);
    useSendUndoStore.setState({ pending: null } as never);
  });

  it.each([['c'], [undefined]])('submits, flags and offers undo in the own account (message account %s)', async (account) => {
    await pressSend(account);
    const [, identityId, sentId, , opts] = vi.mocked(sendEmail).mock.calls[0] as any[];
    expect(identityId).toBe('b');
    expect(sentId).toBe('own-sent');
    expect(opts.accountId.accountId).toBe('c');
    const [ids, , scope] = vi.mocked(patchKeywordsForEmails).mock.calls[0] as any[];
    expect(ids).toEqual(['m1']);
    expect(scope.accountId).toBe('c');
    expect(scope.gen).toBe(opts.accountId.gen);
    expect(useSendUndoStore.getState().pending?.accountId).toBe('c');
  });

  it.each([['c'], [undefined]])('queues offline against the own account (message account %s)', async (account) => {
    const row = await queueOffline(account);
    expect(row.jmapAccountId).toBe('c');
    expect(row.replyTo.jmapAccountId).toBe(account);
  });
});

describe('QuickReplyBox replying to a group address', () => {
  const sendAccounts = {
    d: { name: 'Bob', identities: [
      { id: 'b', name: 'Bob', email: 'bob@x', mayDelete: false },
      { id: 'c', name: 'Team', email: 'team@x', mayDelete: false },
    ] },
    f: { name: 'Team', identities: [{ id: 'b', name: 'Team', email: 'team@x', mayDelete: false }] },
  };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(jmapClient, 'accountId', 'get').mockReturnValue('d');
    vi.spyOn(jmapClient, 'connectedAccountId', 'get').mockReturnValue('d');
    vi.spyOn(jmapClient, 'connectionGen', 'get').mockReturnValue(1);
    vi.spyOn(jmapClient, 'undoSendHold').mockReturnValue(30);
    useEmailStore.setState({ mailboxes, activeAccountId: 'app1' } as never);
    useSettingsStore.setState({ identities: sendAccounts.d.identities, sendAccounts, sendDelaySeconds: 30 } as never);
    useNetworkStore.setState({ online: true } as never);
    useSendUndoStore.setState({ pending: null } as never);
  });
  const toTeam = { ...email, to: [{ email: 'team@x' }] } as unknown as Email;
  async function press(msg: Email) {
    const view = renderComponent(QuickReplyBox, { email: msg, jmapAccountId: 'f', ownerAppAccountId: 'app1', onMoreOptions: vi.fn() });
    findElement(view.tree(), (p) => 'onChangeText' in p)!.props.onChangeText('thanks');
    await findElement(view.tree(), (p) => typeof p.onPress === 'function' && p.disabled === false)!.props.onPress();
  }

  it('sends from the group account and flags in the message account', async () => {
    await press(toTeam);
    expect(sendEmail).not.toHaveBeenCalled();
    const p = vi.mocked(sendRouted).mock.calls[0][0] as any;
    expect(p.route).toEqual({ jmapAccountId: 'f', identityId: 'b' });
    expect(p.blobAccountId).toBe('d');
    expect(p.holdForSeconds).toBe(30);
    expect(jmapClient.undoSendHold).toHaveBeenCalledWith(30, 'f');
    expect(p.outgoing.from[0].email).toBe('team@x');
    expect(p.outgoing.to).toEqual([{ email: 'alice@x', name: undefined }]);
    const [, , scope] = vi.mocked(patchKeywordsForEmails).mock.calls[0] as any[];
    expect(scope.accountId).toBe('f');
    expect(scope.gen).toBe(p.base.gen);
    expect(useSendUndoStore.getState().pending?.accountId).toBe('f');
    expect(useSendUndoStore.getState().pending?.identityId).toBe('b');
  });

  it('refuses offline without queueing', async () => {
    useNetworkStore.setState({ online: false } as never);
    const enqueue = vi.fn(async () => undefined);
    useSendQueueStore.setState({ enqueue } as never);
    await press(toTeam);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendRouted).not.toHaveBeenCalled();
    expect(vi.mocked(Alert.alert).mock.calls[0][1]).toBe('Connect to send from team@x.');
  });

  it('keeps an own reply on the own path', async () => {
    await press(email);
    expect(sendRouted).not.toHaveBeenCalled();
    expect((vi.mocked(sendEmail).mock.calls[0] as any[])[1]).toBe('b');
  });
});

describe('QuickReplyBox before the connection is up', () => {
  it('still queues an own reply offline with the plain identity id', async () => {
    vi.clearAllMocks();
    vi.spyOn(jmapClient, 'accountId', 'get').mockImplementation(() => { throw new Error('Not authenticated - call connect() first'); });
    vi.spyOn(jmapClient, 'connectedAccountId', 'get').mockReturnValue(null);
    vi.spyOn(jmapClient, 'connectionGen', 'get').mockReturnValue(1);
    useEmailStore.setState({ mailboxes, activeAccountId: 'app1' } as never);
    useSettingsStore.setState({
      identities: [{ id: 'b', name: 'Bob', email: 'bob@x', mayDelete: false }], sendAccounts: {}, sendDelaySeconds: 30,
    } as never);
    // The login account recorded earlier, as on a cold start.
    vi.mocked(recordedJmapAccountId).mockReturnValue('c');
    const row = await queueOffline(undefined);
    expect(row.identityId).toBe('b');
    expect(sendRouted).not.toHaveBeenCalled();
  });
});

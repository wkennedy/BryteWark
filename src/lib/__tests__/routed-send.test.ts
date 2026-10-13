import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendEmail = vi.fn();
const getIdentities = vi.fn();
const resolveSendMailboxes = vi.fn();
const copyBlobs = vi.fn();

vi.mock('../../api/email', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock('../../api/identity', () => ({ getIdentities: (...a: unknown[]) => getIdentities(...a) }));
vi.mock('../../api/sent-lookup', () => ({ resolveSendMailboxes: (...a: unknown[]) => resolveSendMailboxes(...a) }));
vi.mock('../../api/blob', async () => {
  class BlobCopyError extends Error {
    constructor(public blobIds: string[]) { super('copy failed'); }
  }
  return { BlobCopyError, copyBlobs: (...a: unknown[]) => copyBlobs(...a) };
});

import { sendRouted, RoutedSendError } from '../routed-send';
import { BlobCopyError } from '../../api/blob';
import { sendErrorAlert } from '../send-errors';

const base = { gen: 7, accountId: 'own' };
const outgoing = () => ({
  from: [{ email: 'team@x' }],
  to: [{ email: 'c@y' }],
  subject: 's',
  attachments: [{ blobId: 'x', type: 'text/plain', name: 'a.txt' }],
});
const params = (over: Record<string, unknown> = {}) => ({
  outgoing: outgoing(),
  route: { jmapAccountId: 'f', identityId: 'b' },
  accountName: 'Team',
  blobAccountId: 'own',
  base,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveSendMailboxes.mockResolvedValue({ sentId: 'e', draftsId: 'd' });
  getIdentities.mockResolvedValue([{ id: 'b', email: 'team@x' }]);
  copyBlobs.mockResolvedValue({ x: 'x2' });
  sendEmail.mockResolvedValue({ scheduled: false, emailId: 'm' });
});

const refusal = async (p: ReturnType<typeof params>) => {
  const e = await sendRouted(p as never).catch((err) => err);
  expect(e).toBeInstanceOf(RoutedSendError);
  expect(sendEmail).not.toHaveBeenCalled();
  return e as RoutedSendError;
};

describe('sendRouted', () => {
  it('sends from the group account with copied blobs', async () => {
    const r = await sendRouted(params({ holdForSeconds: 5 }) as never);
    const at = { gen: 7, accountId: 'f' };
    expect(copyBlobs).toHaveBeenCalledWith('own', at, ['x']);
    const [email, identityId, sentId, hold, opts] = sendEmail.mock.calls[0];
    expect(email.attachments[0].blobId).toBe('x2');
    expect(identityId).toBe('b');
    expect(sentId).toBe('e');
    expect(hold).toBe(5);
    expect(opts.draftsMailboxId).toBe('d');
    expect(opts.accountId).toEqual(at);
    expect(opts.draftAccountId).toBe('own');
    expect(r.accountId).toBe('f');
  });

  it('refuses without Sent or Drafts, touching nothing', async () => {
    resolveSendMailboxes.mockResolvedValue({ sentId: 'e' });
    expect((await refusal(params())).reason).toBe('no_folders');
    expect(copyBlobs).not.toHaveBeenCalled();
  });

  it('refuses when a collided identity id belongs to another address', async () => {
    const p = params({ outgoing: { ...outgoing(), from: [{ email: 'bob@x' }] } });
    expect((await refusal(p)).reason).toBe('identity_gone');
    expect(copyBlobs).not.toHaveBeenCalled();
  });

  it('refuses when the identity is absent from the group', async () => {
    expect((await refusal(params({ route: { jmapAccountId: 'f', identityId: 'c' } }))).reason).toBe('identity_gone');
  });

  it('refuses an envelope sender the identity does not cover', async () => {
    const p = params({ outgoing: { ...outgoing(), envelopeMailFrom: 'bob@x' } });
    expect((await refusal(p)).reason).toBe('identity_gone');
  });

  it('refuses when the attachments cannot be copied', async () => {
    copyBlobs.mockRejectedValue(new BlobCopyError(['x']));
    expect((await refusal(params())).reason).toBe('blob_copy');
  });
});

describe('sendErrorAlert for a routed refusal', () => {
  const ti = (k: string, f?: string, p?: Record<string, string | number>) =>
    (f ?? k).replace(/\{(\w+)\}/g, (_, n) => String(p?.[n] ?? ''));
  it('names the address and account', () => {
    expect(sendErrorAlert(new RoutedSendError('offline', 'team@x', 'Team'), ti).message).toContain('Connect to send from team@x.');
    expect(sendErrorAlert(new RoutedSendError('no_folders', 'team@x', 'Team'), ti).message)
      .toBe("Team has no Sent or Drafts folder, so mail can't be sent from team@x.");
    expect(sendErrorAlert(new RoutedSendError('identity_gone', 'team@x', 'Team'), ti).message)
      .toBe('You can no longer send from team@x in Team.');
    expect(sendErrorAlert(new RoutedSendError('blob_copy', 'team@x', 'Team'), ti).message)
      .toBe("The attachments couldn't be copied to Team. Nothing was sent.");
  });
});

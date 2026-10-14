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

  it('refuses without Drafts, touching nothing', async () => {
    resolveSendMailboxes.mockResolvedValue({ sentId: 'e' });
    expect((await refusal(params())).reason).toBe('no_folders');
    expect(copyBlobs).not.toHaveBeenCalled();
  });

  it('refuses without Sent, touching nothing', async () => {
    resolveSendMailboxes.mockResolvedValue({ draftsId: 'd' });
    expect((await refusal(params())).reason).toBe('no_folders');
    expect(getIdentities).not.toHaveBeenCalled();
    expect(copyBlobs).not.toHaveBeenCalled();
  });

  it('refuses when a collided identity id belongs to another address', async () => {
    const p = params({ outgoing: { ...outgoing(), from: [{ email: 'bob@x' }] } });
    expect((await refusal(p)).reason).toBe('from_override');
    expect(copyBlobs).not.toHaveBeenCalled();
  });

  it('refuses when the identity is absent from the group', async () => {
    expect((await refusal(params({ route: { jmapAccountId: 'f', identityId: 'c' } }))).reason).toBe('identity_gone');
    expect(copyBlobs).not.toHaveBeenCalled();
  });

  it('refuses an envelope sender the identity does not cover', async () => {
    const p = params({ outgoing: { ...outgoing(), envelopeMailFrom: 'bob@x' } });
    expect((await refusal(p)).reason).toBe('from_override');
    expect(copyBlobs).not.toHaveBeenCalled();
  });

  it('refuses a fallback envelope sender the identity does not cover', async () => {
    const p = params({ outgoing: { ...outgoing(), envelopeFallbackMailFrom: 'bob@x' } });
    expect((await refusal(p)).reason).toBe('from_override');
    expect(copyBlobs).not.toHaveBeenCalled();
  });

  it('sends a sub-address of the group address from the group', async () => {
    const p = params({
      outgoing: { ...outgoing(), from: [{ email: 'team+tag@x' }], envelopeMailFrom: 'team@x' },
    });
    await sendRouted(p as never);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].from).toEqual([{ email: 'team+tag@x' }]);
    expect(sendEmail.mock.calls[0][1]).toBe('b');
  });

  it('accepts a tagged override with its fallback, using the composer\'s delimiter', async () => {
    const p = params({
      outgoing: {
        ...outgoing(), from: [{ email: 'team-tag@x' }], envelopeMailFrom: 'team-tag@x', envelopeFallbackMailFrom: 'team@x',
      },
      subAddressDelimiter: '-',
    });
    await sendRouted(p as never);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses a neighbouring address when the group address holds the delimiter', async () => {
    getIdentities.mockResolvedValue([{ id: 'b', email: 'team-sales@x' }]);
    const p = params({
      outgoing: { ...outgoing(), from: [{ email: 'team-ops@x' }], envelopeMailFrom: 'team-ops@x' },
      subAddressDelimiter: '-',
    });
    expect((await refusal(p)).reason).toBe('from_override');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a custom From that is not the group address', async () => {
    const p = params({
      outgoing: { ...outgoing(), from: [{ email: 'bob@x' }], envelopeMailFrom: 'bob@x', envelopeFallbackMailFrom: 'team@x' },
    });
    const e = await refusal(p);
    expect(e.reason).toBe('from_override');
    expect(e.account).toBe('Team');
  });

  it('leaves a sub-address under a wildcard group identity to the wildcard rules', async () => {
    getIdentities.mockResolvedValue([{ id: 'b', email: '*@x' }]);
    await sendRouted(params({ outgoing: { ...outgoing(), from: [{ email: 'team+tag@x' }] } }) as never);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    getIdentities.mockResolvedValue([{ id: 'b', email: '*@x' }]);
    resolveSendMailboxes.mockResolvedValue({ sentId: 'e', draftsId: 'd' });
    const e = await refusal(params({ outgoing: { ...outgoing(), from: [{ email: 'team+tag@y' }] } }));
    expect(e.reason).toBe('from_override');
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
    expect(sendErrorAlert(new RoutedSendError('from_override', 'bob@x', 'Team'), ti).message)
      .toBe("A custom From can't be used when sending from Team.");
  });
});

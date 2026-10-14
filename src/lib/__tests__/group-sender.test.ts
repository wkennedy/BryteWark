import { describe, it, expect, vi, beforeEach } from 'vitest';

const getIdentities = vi.fn();
const resolveSendMailboxes = vi.fn();

vi.mock('../../api/identity', () => ({ getIdentities: (...a: unknown[]) => getIdentities(...a) }));
vi.mock('../../api/sent-lookup', () => ({ resolveSendMailboxes: (...a: unknown[]) => resolveSendMailboxes(...a) }));

import { verifyGroupSender, receivingSendIdentity } from '../group-sender';
import { RoutedSendError } from '../routed-send';
import type { SendIdentity } from '../send-identities';

const sid = (id: string, email: string, jmapAccountId: string, accountName = jmapAccountId): SendIdentity =>
  ({ id, email, name: '', mayDelete: false, jmapAccountId, accountName });

describe('receivingSendIdentity', () => {
  const list = [
    sid('me', 'bob@x', 'own', 'Bob'),
    sid('f/t', 'team@x', 'f', 'Team'),
    sid('f/s', 'sales@x', 'f', 'Team'),
    sid('g/o', 'ops@x', 'g', 'Ops'),
  ];

  it('is the shared account identity the mail was addressed to (To, Cc or Bcc)', () => {
    expect(receivingSendIdentity(list, { to: [{ email: 'team@x' }] }, 'f', 'own')?.id).toBe('f/t');
    expect(receivingSendIdentity(list, { to: [{ email: 'a@y' }], cc: [{ email: 'Sales@X' }] }, 'f', 'own')?.id).toBe('f/s');
    expect(receivingSendIdentity(list, { to: [{ email: 'a@y' }], bcc: [{ email: 'team@x' }] }, 'f', 'own')?.id).toBe('f/t');
  });

  it('matches a tagged delivery to the untagged group identity', () => {
    expect(receivingSendIdentity(list, { to: [{ email: 'team+news@x' }] }, 'f', 'own')?.id).toBe('f/t');
  });

  it('never falls back to the first identity when no group address received it', () => {
    expect(receivingSendIdentity(list, { to: [{ email: 'bob@x' }] }, 'f', 'own')).toBeUndefined();
    expect(receivingSendIdentity(list, { to: [{ email: 'list@y' }] }, 'f', 'own')).toBeUndefined();
  });

  it('only looks in the message account: another group that received it is not used', () => {
    expect(receivingSendIdentity(list, { to: [{ email: 'ops@x' }] }, 'f', 'own')).toBeUndefined();
  });

  it('is undefined for mail in your own account, or when the account is unknown', () => {
    expect(receivingSendIdentity(list, { to: [{ email: 'team@x' }] }, 'own', 'own')).toBeUndefined();
    expect(receivingSendIdentity(list, { to: [{ email: 'team@x' }] }, undefined, 'own')).toBeUndefined();
  });

  it('is undefined with no recipients', () => {
    expect(receivingSendIdentity(list, {}, 'f', 'own')).toBeUndefined();
  });
});

describe('verifyGroupSender', () => {
  const at = { gen: 7, accountId: 'f' };
  const route = { jmapAccountId: 'f', identityId: 'b' };

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSendMailboxes.mockResolvedValue({ sentId: 'e', draftsId: 'd' });
    getIdentities.mockResolvedValue([{ id: 'b', email: 'team@x' }]);
  });

  const refusal = async (addresses: (string | undefined)[], from = 'team@x') => {
    const e = await verifyGroupSender(at, route, addresses, '+', 'Team', from).catch((err) => err);
    expect(e).toBeInstanceOf(RoutedSendError);
    expect(e.address).toBe(from);
    expect(e.account).toBe('Team');
    return e as RoutedSendError;
  };

  it('refuses without Sent, before reading the identities', async () => {
    resolveSendMailboxes.mockResolvedValue({ draftsId: 'd' });
    expect((await refusal(['team@x'])).reason).toBe('no_folders');
    expect(getIdentities).not.toHaveBeenCalled();
  });

  it('refuses without Drafts', async () => {
    resolveSendMailboxes.mockResolvedValue({ sentId: 'e' });
    expect((await refusal(['team@x'])).reason).toBe('no_folders');
  });

  it('refuses when the identity is gone from the group', async () => {
    getIdentities.mockResolvedValue([{ id: 'c', email: 'team@x' }]);
    expect((await refusal(['team@x'])).reason).toBe('identity_gone');
  });

  it('refuses an address the identity does not cover', async () => {
    expect((await refusal(['bob@x'], 'bob@x')).reason).toBe('from_override');
    expect((await refusal(['team@x', 'bob@x'])).reason).toBe('from_override');
  });

  it('refuses an empty From', async () => {
    expect((await refusal([''], '')).reason).toBe('from_override');
  });

  it('returns the group folders and the re-read identity, read in the given scope', async () => {
    const r = await verifyGroupSender(at, route, ['team+tag@x', undefined, 'team@x'], '+', 'Team', 'team+tag@x');
    expect(r).toEqual({ sentId: 'e', draftsId: 'd', identity: { id: 'b', email: 'team@x' } });
    expect(resolveSendMailboxes).toHaveBeenCalledWith(at);
    expect(getIdentities).toHaveBeenCalledWith(at);
  });
});

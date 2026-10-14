import { describe, it, expect, vi, beforeEach } from 'vitest';

const getIdentities = vi.fn();
const resolveSendMailboxes = vi.fn();

vi.mock('../../api/identity', () => ({ getIdentities: (...a: unknown[]) => getIdentities(...a) }));
vi.mock('../../api/sent-lookup', () => ({ resolveSendMailboxes: (...a: unknown[]) => resolveSendMailboxes(...a) }));

import { verifyGroupSender, messageAnswerer, mainSendIdentity } from '../group-sender';
import { RoutedSendError } from '../routed-send';
import type { Identity } from '../../api/types';

const ident = (id: string, email: string, mayDelete = false): Identity =>
  ({ id, email, name: '', mayDelete }) as Identity;

describe('messageAnswerer', () => {
  const sendAccounts = {
    own: { name: 'Bob', identities: [ident('me', 'bob@x')] },
    f: { name: 'Team', identities: [ident('t', 'team@x'), ident('s', 'sales@x')] },
    g: { name: 'Ops', identities: [ident('o', 'ops@x')] },
  };
  const answer = (email: Parameters<typeof messageAnswerer>[0]['email'], at: string | undefined, accounts = sendAccounts) =>
    messageAnswerer({ email, messageJmapAccountId: at, ownAccountId: 'own', sendAccounts: accounts });
  const groupId = (r: ReturnType<typeof messageAnswerer>) => (r.kind === 'group' ? r.identity.id : r.kind);

  it('is the shared account identity the mail was addressed to (To, Cc or Bcc)', () => {
    expect(groupId(answer({ to: [{ email: 'team@x' }] }, 'f'))).toBe('f/t');
    expect(groupId(answer({ to: [{ email: 'a@y' }], cc: [{ email: 'Sales@X' }] }, 'f'))).toBe('f/s');
    expect(groupId(answer({ to: [{ email: 'a@y' }], bcc: [{ email: 'sales@x' }] }, 'f'))).toBe('f/s');
  });

  it('matches a tagged delivery to the untagged group identity', () => {
    expect(groupId(answer({ to: [{ email: 'sales+news@x' }] }, 'f'))).toBe('f/s');
  });

  it('decorates the group identity with its account and routed id', () => {
    const r = answer({ to: [{ email: 'team@x' }] }, 'f');
    expect(r).toEqual({ kind: 'group', identity: { ...ident('f/t', 'team@x'), jmapAccountId: 'f', accountName: 'Team' } });
  });

  it('is the group main identity, never yours, when no group address received it', () => {
    // A list copy in the group folder, or one addressed to you.
    expect(groupId(answer({ to: [{ email: 'list@y' }] }, 'f'))).toBe('f/t');
    expect(groupId(answer({ to: [{ email: 'bob@x' }] }, 'f'))).toBe('f/t');
    expect(groupId(answer({}, 'f'))).toBe('f/t');
  });

  it('only looks in the message account: another group that received it is not used', () => {
    expect(groupId(answer({ to: [{ email: 'ops@x' }] }, 'f'))).toBe('f/t');
  });

  it('answers mail a group catch-all received from the main non-wildcard identity', () => {
    const accounts = { ...sendAccounts, f: { name: 'Team', identities: [ident('w', '*@x'), ident('t', 'team@x', true)] } };
    expect(groupId(answer({ to: [{ email: 'alias@x' }] }, 'f', accounts))).toBe('f/t');
  });

  it('is refused for a share with nothing to send from, naming the account', () => {
    // Folder-only share: no sendAccounts entry; the session name or the id names it.
    expect(answer({ to: [{ email: 'team@x' }] }, 'h')).toEqual({ kind: 'refused', account: 'h' });
    const accounts = { ...sendAccounts, f: { name: 'Team', identities: [ident('w', '*@x')] } };
    expect(answer({ to: [{ email: 'a@x' }] }, 'f', accounts)).toEqual({ kind: 'refused', account: 'Team' });
    expect(answer({ to: [{ email: 'a@x' }] }, 'f', { ...sendAccounts, f: { name: 'Team', identities: [] } }))
      .toEqual({ kind: 'refused', account: 'Team' });
  });

  it('is your own for mail in your own account', () => {
    expect(answer({ to: [{ email: 'team@x' }] }, 'own')).toEqual({ kind: 'own' });
    expect(answer({ to: [{ email: 'team@x' }] }, undefined)).toEqual({ kind: 'own' });
  });

  it('never takes mail in another account for yours while unconnected', () => {
    const r = messageAnswerer({ email: { to: [{ email: 'team@x' }] }, messageJmapAccountId: 'f', ownAccountId: null, sendAccounts });
    expect(groupId(r)).toBe('f/t');
  });
});

describe('mainSendIdentity', () => {
  it('is the first undeletable identity, else the first, skipping catch-alls', () => {
    expect(mainSendIdentity([ident('a', 'a@x', true), ident('b', 'b@x')])?.id).toBe('b');
    expect(mainSendIdentity([ident('w', '*@x'), ident('a', 'a@x', true), ident('b', 'b@x', true)])?.id).toBe('a');
    expect(mainSendIdentity([ident('w', '*@x')])).toBeUndefined();
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

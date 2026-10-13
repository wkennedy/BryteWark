import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    connectionGen: 1,
    request: vi.fn(),
    currentSession: null as unknown,
    getAccountName: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { getIdentities, getSendIdentities, createIdentity, updateIdentity, deleteIdentity } from '../identity';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('identity operations', () => {
  describe('getIdentities', () => {
    it('should fetch identities', async () => {
      const identities = [{ id: 'id-1', name: 'Me', email: 'me@example.com' }];
      mockRequest.mockResolvedValue({
        methodResponses: [['Identity/get', { list: identities }, '0']],
      });

      const result = await getIdentities();
      expect(result).toEqual(identities);
      expect(mockRequest).toHaveBeenCalledWith(
        [['Identity/get', { accountId: 'acc-1' }, '0']],
        expect.arrayContaining(['urn:ietf:params:jmap:submission']),
      );
    });
  });

  describe('getIdentities on a scope', () => {
    it('reads the scope\'s account on the scope\'s connection', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['Identity/get', { list: [] }, '0']] });
      await getIdentities({ gen: 7, accountId: 'f' });
      expect(mockRequest).toHaveBeenCalledWith(
        [['Identity/get', { accountId: 'f' }, '0']],
        expect.arrayContaining(['urn:ietf:params:jmap:submission']),
        { gen: 7 },
      );
    });
  });

  describe('getSendIdentities', () => {
    const SUB = 'urn:ietf:params:jmap:submission';
    const client = jmapClient as unknown as {
      currentSession: unknown;
      getAccountName: ReturnType<typeof vi.fn>;
    };
    beforeEach(() => {
      client.currentSession = {
        accounts: {
          d: { accountCapabilities: { [SUB]: {} } },
          f: { accountCapabilities: { [SUB]: {} } },
          g: { accountCapabilities: { [SUB]: {} } },
          h: { accountCapabilities: {} },
        },
      };
      client.getAccountName.mockImplementation((id: string) => (id === 'f' ? 'team@x' : undefined));
    });

    it('reads own and each submission-capable shared account, dropping a forbidden one', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Identity/get', { list: [{ id: 'b', email: 'bob@x' }] }, '0'],
          ['Identity/get', { list: [{ id: 'b', email: 'team@x' }] }, '1'],
          ['error', { type: 'forbidden' }, '2'],
        ],
      });
      const result = await getSendIdentities({ gen: 4, accountId: 'd' });
      const [calls, , opts] = mockRequest.mock.calls[0];
      expect(calls.map((c: unknown[]) => [c[0], (c[1] as { accountId: string }).accountId])).toEqual([
        ['Identity/get', 'd'], ['Identity/get', 'f'], ['Identity/get', 'g'],
      ]);
      expect(opts).toEqual({ gen: 4 });
      expect(Object.keys(result)).toEqual(['d', 'f']);
      expect(result.f).toEqual({ name: 'team@x', identities: [{ id: 'b', email: 'team@x' }] });
      expect(result.d.name).toBe('d');
    });

    it('rejects when the own account errors', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverFail' }, '0'],
          ['Identity/get', { list: [] }, '1'],
          ['Identity/get', { list: [] }, '2'],
        ],
      });
      await expect(getSendIdentities({ gen: 4, accountId: 'd' })).rejects.toThrow();
    });
  });

  describe('createIdentity', () => {
    it('should create a new identity', async () => {
      const created = { id: 'id-new', name: 'Work', email: 'work@example.com' };
      // The create echo carries only server-set properties; the API re-reads
      // the full identity afterwards.
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [['Identity/set', { created: { 'new-identity': { id: 'id-new' } } }, '0']],
        })
        .mockResolvedValueOnce({
          methodResponses: [['Identity/get', { list: [created] }, '0']],
        });

      const result = await createIdentity({ name: 'Work', email: 'work@example.com' });
      expect(result).toEqual(created);
    });
  });

  describe('updateIdentity', () => {
    it('should update identity fields', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Identity/set', { updated: {} }, '0']],
      });

      await updateIdentity('id-1', { name: 'Updated Name' });

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].update).toEqual({ 'id-1': { name: 'Updated Name' } });
    });
  });

  describe('deleteIdentity', () => {
    it('should destroy an identity', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Identity/set', { destroyed: ['id-1'] }, '0']],
      });

      await deleteIdentity('id-1');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].destroy).toEqual(['id-1']);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({
  accountId: 'acc-1',
  serverUrl: 'https://mail.example',
  username: 'me',
}));

vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../api/identity', () => ({ getSendIdentities: vi.fn() }));

import { getSendIdentities } from '../../api/identity';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '../settings-store';

const mockSend = getSendIdentities as ReturnType<typeof vi.fn>;
// Most tests only care about the own account's list: wrap it as the one-account result.
const mockGetIdentities = vi.fn();
const team = { id: 'b', name: 'Team', email: 'team@example.com' };
const me = { id: 'i1', name: 'Me', email: 'me@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetIdentities.mockReset();
  mockSend.mockImplementation(async () => {
    const own = client.accountId; // the account the read was made for
    return { [own]: { name: 'Me', identities: await mockGetIdentities() } };
  });
  client.accountId = 'acc-1';
  client.serverUrl = 'https://mail.example';
  useSettingsStore.getState().reset();
});

describe('identities', () => {
  it('reads them once per account, even when the account has none', async () => {
    mockGetIdentities.mockResolvedValue([]);

    await useSettingsStore.getState().ensureIdentities();
    await useSettingsStore.getState().ensureIdentities();

    expect(mockGetIdentities).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().identities).toEqual([]);
  });

  it('shares one request between concurrent callers', async () => {
    mockGetIdentities.mockResolvedValue([me]);

    await Promise.all([
      useSettingsStore.getState().ensureIdentities(),
      useSettingsStore.getState().ensureIdentities(),
      useSettingsStore.getState().fetchIdentities(),
    ]);

    expect(mockGetIdentities).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().identities).toEqual([me]);
  });

  it('drops another account’s identities and reads this one’s', async () => {
    mockGetIdentities.mockResolvedValueOnce([me]);
    await useSettingsStore.getState().ensureIdentities();

    client.serverUrl = 'https://other.example';
    let release!: (list: unknown[]) => void;
    mockGetIdentities.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const pending = useSettingsStore.getState().ensureIdentities();

    expect(useSettingsStore.getState().identities).toEqual([]);
    release([{ id: 'i2', name: 'Other', email: 'other@example.com' }]);
    await pending;
    expect(useSettingsStore.getState().identities.map((i) => i.id)).toEqual(['i2']);
  });

  it('asks again after a failed read', async () => {
    mockGetIdentities.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([me]);

    await useSettingsStore.getState().ensureIdentities();
    await useSettingsStore.getState().ensureIdentities();

    expect(mockGetIdentities).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().identities).toEqual([me]);
  });

  it('keeps a read that lands after switching accounts out of the new one', async () => {
    let release!: (list: unknown[]) => void;
    mockGetIdentities.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const pending = useSettingsStore.getState().ensureIdentities();

    client.accountId = 'acc-2';
    release([me]);
    await pending;

    expect(useSettingsStore.getState().identities).toEqual([]);
    expect(useSettingsStore.getState().identitiesFor).toBeNull();
  });
});

describe('sendable accounts', () => {
  const both = () => ({ d: { name: 'Bob', identities: [me] }, f: { name: 'Team account', identities: [team] } });

  beforeEach(() => { client.accountId = 'd'; });

  it('holds every account, with identities being the own list', async () => {
    mockSend.mockResolvedValue(both());
    await useSettingsStore.getState().fetchIdentities();
    expect(Object.keys(useSettingsStore.getState().sendAccounts)).toEqual(['d', 'f']);
    expect(useSettingsStore.getState().identities).toEqual([me]);
  });

  it('caches both accounts, own first', async () => {
    await AsyncStorage.clear();
    mockSend.mockResolvedValue(both());
    await useSettingsStore.getState().fetchIdentities();
    const cached = JSON.parse((await AsyncStorage.getItem('webmail:identities:v2:me@mail.example'))!);
    expect(Object.keys(cached)).toEqual(['d', 'f']);
  });

  it('refresh updates the sendable accounts too', async () => {
    mockSend.mockResolvedValueOnce({ d: both().d }).mockResolvedValueOnce(both());
    await useSettingsStore.getState().fetchIdentities();
    await useSettingsStore.getState().refreshIdentities();
    expect(Object.keys(useSettingsStore.getState().sendAccounts)).toEqual(['d', 'f']);
  });

  it('leaves them untouched when the scope changes during the read', async () => {
    let release!: (v: unknown) => void;
    mockSend.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const pending = useSettingsStore.getState().fetchIdentities();
    client.serverUrl = 'https://other.example';
    release(both());
    await pending;
    expect(useSettingsStore.getState().sendAccounts).toEqual({});
    expect(useSettingsStore.getState().identities).toEqual([]);
  });

  it('resets with the identities', async () => {
    mockSend.mockResolvedValue(both());
    await useSettingsStore.getState().fetchIdentities();
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().sendAccounts).toEqual({});
  });
});

describe('refreshIdentities', () => {
  const other = { id: 'i2', name: 'Other', email: 'other@example.com' };

  it('reads again when the list is held for the current account', async () => {
    mockGetIdentities.mockResolvedValueOnce([me]).mockResolvedValueOnce([me, other]);
    await useSettingsStore.getState().ensureIdentities();

    await useSettingsStore.getState().refreshIdentities();

    expect(mockGetIdentities).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().identities).toEqual([me, other]);
  });

  it('does nothing when identities were never loaded', async () => {
    await useSettingsStore.getState().refreshIdentities();

    expect(mockGetIdentities).not.toHaveBeenCalled();
  });

  it('drops a result that lands after switching accounts', async () => {
    mockGetIdentities.mockResolvedValueOnce([me]);
    await useSettingsStore.getState().ensureIdentities();
    let release!: (list: unknown[]) => void;
    mockGetIdentities.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const pending = useSettingsStore.getState().refreshIdentities();

    client.accountId = 'acc-2';
    release([other]);
    await pending;

    expect(useSettingsStore.getState().identities).toEqual([me]);
  });

  it('keeps the old list and the error state when the read fails', async () => {
    mockGetIdentities.mockResolvedValueOnce([me]).mockRejectedValueOnce(new Error('offline'));
    await useSettingsStore.getState().ensureIdentities();

    await useSettingsStore.getState().refreshIdentities();

    expect(useSettingsStore.getState().identities).toEqual([me]);
    expect(useSettingsStore.getState().error).toBeNull();
    expect(useSettingsStore.getState().loading).toBe(false);
  });
});

describe('identity cache', () => {
  const key = (id: string) => `webmail:identities:v2:${id}`;
  // The client's login: the app account id is generateAccountId(username, serverUrl).
  const ME = 'me@mail.example';

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('caches a fetched list for the client\'s app account', async () => {
    mockGetIdentities.mockResolvedValue([me]);
    await useSettingsStore.getState().fetchIdentities();
    expect(JSON.parse((await AsyncStorage.getItem(key(ME)))!)['acc-1'].identities.map((i: { id: string }) => i.id)).toEqual(['i1']);
  });

  it('caches a refreshed list', async () => {
    mockGetIdentities.mockResolvedValueOnce([me]);
    await useSettingsStore.getState().fetchIdentities();
    mockGetIdentities.mockResolvedValueOnce([me, { id: 'i2', name: 'Two', email: 'two@example.com' }]);
    await useSettingsStore.getState().refreshIdentities();
    expect(JSON.parse((await AsyncStorage.getItem(key(ME)))!)['acc-1'].identities).toHaveLength(2);
  });

  it('does not cache a list that lands after switching accounts', async () => {
    let release!: (list: unknown[]) => void;
    mockGetIdentities.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const pending = useSettingsStore.getState().fetchIdentities();
    client.serverUrl = 'https://other.example';
    release([me]);
    await pending;
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });

  it('writes nothing when the login is unknown', async () => {
    client.username = null as unknown as string;
    try {
      mockGetIdentities.mockResolvedValue([me]);
      await useSettingsStore.getState().fetchIdentities();
      expect(await AsyncStorage.getAllKeys()).toEqual([]);
    } finally {
      client.username = 'me';
    }
  });
});

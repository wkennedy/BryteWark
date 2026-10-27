import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as WebBrowser from 'expo-web-browser';

vi.mock('../client-cert', () => ({
  secureFetch: vi.fn(),
}));

import { secureFetch } from '../client-cert';
import { loginWithPkce, type OAuthMetadata } from '../oauth-native';
import { HandoffCancelledError } from '../oauth';

const mockOpenAuthSession = WebBrowser.openAuthSessionAsync as ReturnType<typeof vi.fn>;

const metadata: OAuthMetadata = {
  authorization_endpoint: 'https://mail.example.com/authorize/code',
  token_endpoint: 'https://mail.example.com/auth/token',
};

// The browser mock answers every session with `cancel`, so the flow stops
// right after opening the authorization URL - which is all these tests need.
async function openedSession(meta: OAuthMetadata, addAccount?: boolean) {
  await expect(loginWithPkce('https://mail.example.com', meta, { addAccount })).rejects.toBeInstanceOf(
    HandoffCancelledError,
  );
  expect(mockOpenAuthSession).toHaveBeenCalledTimes(1);
  const [authUrl, redirectUri, options] = mockOpenAuthSession.mock.calls[0];
  return { params: new URL(authUrl as string).searchParams, redirectUri, options };
}

describe('loginWithPkce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the browser session and sends no prompt for the first sign-in', async () => {
    const { params, redirectUri, options } = await openedSession(metadata);

    expect(params.get('prompt')).toBeNull();
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(redirectUri).toBe('bulwarkmobile://auth/callback');
    expect(options).toBeUndefined();
  });

  it('asks for the account picker in a private session when adding an account', async () => {
    const { params, options } = await openedSession(metadata, true);

    expect(params.get('prompt')).toBe('select_account');
    expect(options).toEqual({ preferEphemeralSession: true });
  });

  it('asks for a fresh login when the server advertises no account picker', async () => {
    const keycloak = { ...metadata, prompt_values_supported: ['none', 'login', 'consent'] };
    const { params } = await openedSession(keycloak, true);

    expect(params.get('prompt')).toBe('login');
  });

  it('keeps the account picker when the server advertises it', async () => {
    const picker = { ...metadata, prompt_values_supported: ['none', 'login', 'select_account'] };
    const { params } = await openedSession(picker, true);

    expect(params.get('prompt')).toBe('select_account');
  });
});

describe('loginWithPkce token response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Answer the browser with a code for the state it was opened with.
  function signInAnswers(tokenResponse: Record<string, unknown>) {
    mockOpenAuthSession.mockImplementationOnce(async (authUrl: string) => {
      const state = new URL(authUrl).searchParams.get('state');
      return { type: 'success', url: `bulwarkmobile://auth/callback?code=c0de&state=${state}` };
    });
    (secureFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => tokenResponse,
    });
  }

  it('keeps the id token beside the bundle, for ending the provider session on sign-out', async () => {
    signInAnswers({ access_token: 'at', refresh_token: 'rt', expires_in: 300, id_token: 'id.jwt.sig' });
    const result = await loginWithPkce('https://mail.example.com', metadata);
    expect(result.idToken).toBe('id.jwt.sig');
    expect(result.source).toBe('native');
    expect(result.accessToken).toBe('at');
  });

  it('has no id token when the provider sends none', async () => {
    signInAnswers({ access_token: 'at' });
    const result = await loginWithPkce('https://mail.example.com', metadata);
    expect(result.idToken).toBeUndefined();
  });
});

// Stalwart 1.0 enforces the OAuth profile for open public clients: an
// unregistered client id is refused, and a token reaches only the services its
// scopes name. Such a server advertises the service scopes; the app registers
// itself dynamically there and asks for them.
describe('loginWithPkce on a server with service scopes', () => {
  const SERVICE_SCOPES = [
    'urn:ietf:params:oauth:scope:mail',
    'urn:ietf:params:oauth:scope:contacts',
    'urn:ietf:params:oauth:scope:calendars',
    'urn:ietf:params:oauth:scope:files',
  ];
  const stalwart: OAuthMetadata = {
    ...metadata,
    registration_endpoint: 'https://mail.example.com/auth/register',
    scopes_supported: [...SERVICE_SCOPES, 'openid', 'offline_access'],
  };
  const fetchMock = secureFetch as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function registers(clientId = 'swc1.abc') {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ client_id: clientId, client_id_issued_at: 1 }),
    });
  }

  it('registers a public client and signs in with its id and the service scopes', async () => {
    registers();
    const { params, redirectUri } = await openedSession(stalwart);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/auth/register');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.redirect_uris).toEqual(['org.bulwarkmail.mobile:/oauth/callback']);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.scope.split(' ')).toEqual(expect.arrayContaining(SERVICE_SCOPES));

    expect(params.get('client_id')).toBe('swc1.abc');
    expect(params.get('redirect_uri')).toBe('org.bulwarkmail.mobile:/oauth/callback');
    expect(redirectUri).toBe('org.bulwarkmail.mobile:/oauth/callback');
    expect(params.get('scope')!.split(' ').sort()).toEqual([...SERVICE_SCOPES, 'offline_access', 'openid'].sort());
  });

  it('asks only for the service scopes the server offers', async () => {
    registers();
    const noFiles = { ...stalwart, scopes_supported: stalwart.scopes_supported!.filter((s) => !s.endsWith(':files')) };
    const { params } = await openedSession(noFiles);
    expect(params.get('scope')).not.toContain('files');
  });

  it('keeps the registered client id in the token bundle, for refresh and revocation', async () => {
    registers('swc1.kept');
    mockOpenAuthSession.mockImplementationOnce(async (authUrl: string) => {
      const state = new URL(authUrl).searchParams.get('state');
      return { type: 'success', url: `org.bulwarkmail.mobile:/oauth/callback?code=c0de&state=${state}` };
    });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt' }) });

    const result = await loginWithPkce('https://mail.example.com', stalwart);

    expect(result.clientId).toBe('swc1.kept');
    const tokenBody = new URLSearchParams((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(tokenBody.get('client_id')).toBe('swc1.kept');
    expect(tokenBody.get('redirect_uri')).toBe('org.bulwarkmail.mobile:/oauth/callback');
  });

  it('fails the sign-in when the registration is refused', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_redirect_uri"}',
    });
    await expect(loginWithPkce('https://mail.example.com', stalwart)).rejects.toThrow(/registration failed: 400/i);
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
  });

  it('refuses a registration endpoint on another host over plain http', async () => {
    const foreign = { ...stalwart, registration_endpoint: 'http://evil.example.net/register' };
    await expect(loginWithPkce('https://mail.example.com', foreign)).rejects.toThrow(/not trusted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the fixed client id where the server offers no service scopes (Keycloak, Stalwart 0.16)', async () => {
    const keycloak = { ...metadata, registration_endpoint: 'https://mail.example.com/register', scopes_supported: ['openid', 'email', 'profile'] };
    const { params, redirectUri } = await openedSession(keycloak);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(params.get('client_id')).toBe('bulwark-webmail');
    expect(params.get('scope')).toBe('openid email profile');
    expect(redirectUri).toBe('bulwarkmobile://auth/callback');
  });
});

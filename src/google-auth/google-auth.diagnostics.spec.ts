// Richer googleapis mock (adds getAccessToken + the `tokens` event emitter)
// so we can drive verifyConnectivity / invalid_grant / config paths.
jest.mock('googleapis', () => {
  const generateAuthUrl = jest.fn().mockReturnValue('https://consent.example');
  const OAuth2 = jest.fn().mockImplementation(() => {
    const handlers: Record<string, (arg: any) => void> = {};
    return {
      credentials: {},
      generateAuthUrl,
      setCredentials: jest.fn(function (this: any, c: any) {
        this.credentials = c;
      }),
      getToken: jest.fn().mockResolvedValue({ tokens: { refresh_token: 'rt' } }),
      getAccessToken: jest.fn(),
      on: jest.fn((event: string, cb: (arg: any) => void) => {
        handlers[event] = cb;
      }),
      __emit: (event: string, arg: any) => handlers[event]?.(arg),
    };
  });
  return { google: { auth: { OAuth2 } } };
});

import { google } from 'googleapis';
import { GoogleOAuthService } from './google-auth.service';
import { GoogleOAuthGrantError } from './google-oauth.errors';
import { OAuthTokenService } from '../oauth-token/oauth-token.service';

const OAuth2Mock = google.auth.OAuth2 as unknown as jest.Mock;

/** Fake token store (the refresh token lives in Mongo now, not env). */
function makeTokens(initial: string | null = 'rt') {
  const state = { _token: initial };
  return {
    _token: initial,
    getRefreshToken: jest.fn(async () => state._token),
    getRecord: jest.fn(async () => null),
    saveRefreshToken: jest.fn(async (rt: string) => {
      state._token = rt;
    }),
    markReauthRequired: jest.fn(async () => undefined),
    touchRefreshed: jest.fn(async () => undefined),
    _state: state,
  } as any;
}

describe('GoogleOAuthService — diagnostics & hardening', () => {
  let svc: GoogleOAuthService;
  let tokens: ReturnType<typeof makeTokens>;
  const ENV = { ...process.env };

  beforeEach(() => {
    tokens = makeTokens('rt');
    svc = new GoogleOAuthService(tokens as unknown as OAuthTokenService);
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    OAuth2Mock.mockClear();
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ENV };
    jest.restoreAllMocks();
  });

  it('sets the stored refresh token (trimmed by the token store) on the client', async () => {
    tokens._state._token = 'rt-trimmed';
    const client = await svc.getAuthenticatedClient();
    expect((client as any).setCredentials).toHaveBeenCalledWith({
      refresh_token: 'rt-trimmed',
    });
  });

  it('missingConfigKeys() lists only the missing APP creds (token is in DB now)', () => {
    // The refresh token is no longer an env key → never listed here.
    expect(svc.missingConfigKeys()).toEqual([]);
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect(svc.missingConfigKeys()).toEqual(['GOOGLE_OAUTH_CLIENT_ID']);
  });

  it('verifyConnectivity returns true when the refresh succeeds', async () => {
    const client = await svc.getAuthenticatedClient();
    (client as any).getAccessToken.mockResolvedValue({ token: 'at' });
    await expect(svc.verifyConnectivity()).resolves.toBe(true);
  });

  it('verifyConnectivity returns false on invalid_grant, marks REAUTH_REQUIRED AND resets the cached client', async () => {
    const client = await svc.getAuthenticatedClient();
    (client as any).getAccessToken.mockRejectedValue({
      response: { status: 400, data: { error: 'invalid_grant' } },
    });
    await expect(svc.verifyConnectivity()).resolves.toBe(false);
    expect(tokens.markReauthRequired).toHaveBeenCalled();
    // Cache reset → next getAuthenticatedClient builds a fresh OAuth2 client.
    OAuth2Mock.mockClear();
    await svc.getAuthenticatedClient();
    expect(OAuth2Mock).toHaveBeenCalledTimes(1);
  });

  it('verifyConnectivity returns false (no throw) on a transient error', async () => {
    const client = await svc.getAuthenticatedClient();
    (client as any).getAccessToken.mockRejectedValue({ code: 503 });
    await expect(svc.verifyConnectivity()).resolves.toBe(false);
  });

  it('PERSISTS a ROTATED refresh token from the tokens event (never loses it)', async () => {
    const client: any = await svc.getAuthenticatedClient();
    client.__emit('tokens', { access_token: 'at', refresh_token: 'NEW_RT' });
    // The in-client credentials are updated synchronously…
    expect(client.credentials.refresh_token).toBe('NEW_RT');
    // …and the rotated token is persisted to the DB (async event handler).
    await Promise.resolve();
    expect(tokens.saveRefreshToken).toHaveBeenCalledWith('NEW_RT');
  });

  it('does NOT persist/wipe the refresh token on an access-token-only refresh', async () => {
    const client: any = await svc.getAuthenticatedClient();
    expect(client.credentials.refresh_token).toBe('rt');
    client.__emit('tokens', { access_token: 'at2', expiry_date: Date.now() });
    expect(client.credentials.refresh_token).toBe('rt');
    await Promise.resolve();
    expect(tokens.saveRefreshToken).not.toHaveBeenCalled();
  });

  describe('handleCallbackTokens', () => {
    it('SAVES a refresh token to the DB and reports SAVED', async () => {
      await expect(
        svc.handleCallbackTokens({ refresh_token: 'cbrt' }),
      ).resolves.toBe('SAVED');
      expect(tokens.saveRefreshToken).toHaveBeenCalledWith('cbrt', {
        scopes: GoogleOAuthService.SCOPES,
      });
    });

    it('does NOT save (and reports NO_REFRESH_TOKEN) when absent', async () => {
      await expect(svc.handleCallbackTokens({})).resolves.toBe(
        'NO_REFRESH_TOKEN',
      );
      expect(tokens.saveRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe('getConnectionHealth', () => {
    it('NOT_CONNECTED when no token is stored', async () => {
      tokens._state._token = null;
      await expect(svc.getConnectionHealth()).resolves.toMatchObject({
        status: 'NOT_CONNECTED',
      });
    });

    it('CONNECTED when a live refresh succeeds', async () => {
      const client = await svc.getAuthenticatedClient();
      (client as any).getAccessToken.mockResolvedValue({ token: 'at' });
      await expect(svc.getConnectionHealth()).resolves.toMatchObject({
        status: 'CONNECTED',
        refreshTokenValid: true,
      });
    });

    it('REAUTH_REQUIRED when the stored token is rejected', async () => {
      const client = await svc.getAuthenticatedClient();
      (client as any).getAccessToken.mockRejectedValue({
        response: { status: 400, data: { error: 'invalid_grant' } },
      });
      await expect(svc.getConnectionHealth()).resolves.toMatchObject({
        status: 'REAUTH_REQUIRED',
        refreshTokenValid: false,
      });
    });
  });

  describe('onModuleInit config validation', () => {
    it('is NON-FATAL in development when the APP creds are missing', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      process.env.NODE_ENV = 'development';
      await expect(svc.onModuleInit()).resolves.toBeUndefined();
    });

    it('THROWS in production when the APP creds are missing', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      process.env.NODE_ENV = 'production';
      await expect(svc.onModuleInit()).rejects.toThrow(/manquantes|invalide/i);
    });

    it('is NON-FATAL in production when only the token is absent (pre-authorization)', async () => {
      tokens._state._token = null; // creds present, but not authorized yet
      process.env.NODE_ENV = 'production';
      await expect(svc.onModuleInit()).resolves.toBeUndefined();
    });
  });

  it('buildInvalidGrantDiagnostic is thrown type GoogleOAuthGrantError (non-retryable family)', () => {
    // sanity: the diagnostic type is exported and instanceof-able for callers.
    const e = new GoogleOAuthGrantError('x', 'invalid_grant');
    expect(e).toBeInstanceOf(Error);
    expect(e.googleError).toBe('invalid_grant');
  });
});

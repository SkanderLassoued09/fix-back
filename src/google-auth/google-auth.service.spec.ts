// googleapis is heavy + ESM-ish; mock the OAuth2 client so the unit test never
// touches the network and we can assert on the scopes / credentials wiring.
jest.mock('googleapis', () => {
  const generateAuthUrl = jest.fn().mockReturnValue('https://consent.example');
  const setCredentials = jest.fn();
  const getToken = jest.fn().mockResolvedValue({ tokens: { refresh_token: 'rt' } });
  const OAuth2 = jest
    .fn()
    .mockImplementation(() => ({ generateAuthUrl, setCredentials, getToken }));
  return { google: { auth: { OAuth2 } } };
});

import { google } from 'googleapis';
import { GoogleOAuthService } from './google-auth.service';
import { OAuthTokenService } from '../oauth-token/oauth-token.service';

const OAuth2Mock = google.auth.OAuth2 as unknown as jest.Mock;

/**
 * Fake OAuthTokenService — the refresh token now lives in Mongo, not env. The
 * fake serves a token from an in-memory value so the unit test stays hermetic
 * and can flip "not authorized" by returning null.
 */
function makeTokens(initial: string | null = 'rt'): jest.Mocked<
  Pick<
    OAuthTokenService,
    | 'getRefreshToken'
    | 'getRecord'
    | 'saveRefreshToken'
    | 'markReauthRequired'
    | 'touchRefreshed'
  >
> & { _token: string | null } {
  const state = { _token: initial };
  return {
    // Live proxy to the closure so a test mutating `tokens._token` actually
    // changes what `getRefreshToken` serves.
    get _token() {
      return state._token;
    },
    set _token(v: string | null) {
      state._token = v;
    },
    getRefreshToken: jest.fn(async () => state._token),
    getRecord: jest.fn(async () => null),
    saveRefreshToken: jest.fn(async (rt: string) => {
      state._token = rt;
    }),
    markReauthRequired: jest.fn(async () => undefined),
    touchRefreshed: jest.fn(async () => undefined),
  } as any;
}

describe('GoogleOAuthService — shared Drive + Sheets OAuth', () => {
  let svc: GoogleOAuthService;
  let tokens: ReturnType<typeof makeTokens>;
  const ENV = { ...process.env };

  beforeEach(() => {
    tokens = makeTokens('rt');
    svc = new GoogleOAuthService(tokens as unknown as OAuthTokenService);
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    OAuth2Mock.mockClear();
  });

  afterEach(() => {
    process.env = { ...ENV };
  });

  it('declares BOTH the Drive and Sheets scopes', () => {
    expect(GoogleOAuthService.SCOPES).toEqual(
      expect.arrayContaining([
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/spreadsheets',
      ]),
    );
  });

  it('requests the combined scopes + a state on the consent URL', () => {
    svc.generateAuthUrl();
    const instance = OAuth2Mock.mock.results[0].value;
    expect(instance.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: 'offline',
        prompt: 'consent',
        scope: GoogleOAuthService.SCOPES,
        state: expect.any(String),
      }),
    );
  });

  it('sets the refresh token (from the DB) on a single shared client (cached)', async () => {
    const c1 = await svc.getAuthenticatedClient();
    const c2 = await svc.getAuthenticatedClient();
    expect(c1).toBe(c2); // cached by token value → one refresh cycle for both
    expect(OAuth2Mock).toHaveBeenCalledTimes(1);
    expect((c1 as any).setCredentials).toHaveBeenCalledWith({
      refresh_token: 'rt',
    });
  });

  it('throws a clear error when no refresh token is stored', async () => {
    tokens._token = null;
    await expect(svc.getAuthenticatedClient()).rejects.toThrow(/refresh token/i);
  });

  it('throws a descriptive config error naming the missing key', () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    // New custom exception (InvalidOAuthConfigError) names exactly what's absent.
    expect(() => svc.buildOAuthClient()).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });

  it('isConfigured() needs client id + secret + a stored refresh token', async () => {
    await expect(svc.isConfigured()).resolves.toBe(true);
    tokens._token = null;
    await expect(svc.isConfigured()).resolves.toBe(false);
  });
});

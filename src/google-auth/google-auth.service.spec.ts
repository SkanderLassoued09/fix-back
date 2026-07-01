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

const OAuth2Mock = google.auth.OAuth2 as unknown as jest.Mock;

describe('GoogleOAuthService — shared Drive + Sheets OAuth', () => {
  let svc: GoogleOAuthService;
  const ENV = { ...process.env };

  beforeEach(() => {
    svc = new GoogleOAuthService();
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'rt';
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

  it('requests the combined scopes on the consent URL', () => {
    svc.generateAuthUrl();
    const instance = OAuth2Mock.mock.results[0].value;
    expect(instance.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: 'offline',
        prompt: 'consent',
        scope: GoogleOAuthService.SCOPES,
      }),
    );
  });

  it('sets the refresh token on a single shared client (cached)', () => {
    const c1 = svc.getAuthenticatedClient();
    const c2 = svc.getAuthenticatedClient();
    expect(c1).toBe(c2); // cached → one refresh cycle for Drive + Sheets
    expect(OAuth2Mock).toHaveBeenCalledTimes(1);
    expect((c1 as any).setCredentials).toHaveBeenCalledWith({
      refresh_token: 'rt',
    });
  });

  it('throws a clear error when the refresh token is missing', () => {
    delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    expect(() => svc.getAuthenticatedClient()).toThrow(/refresh token/i);
  });

  it('throws when the OAuth client id/secret are missing', () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect(() => svc.buildOAuthClient()).toThrow(/credentials missing/i);
  });

  it('isConfigured() needs client id + secret + refresh token', () => {
    expect(svc.isConfigured()).toBe(true);
    delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    expect(svc.isConfigured()).toBe(false);
  });
});

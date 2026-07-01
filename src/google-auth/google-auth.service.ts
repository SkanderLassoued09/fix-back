import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';

/** Instance type of the googleapis OAuth2 client (no extra dependency import). */
type OAuth2 = InstanceType<typeof google.auth.OAuth2>;

/**
 * Shared Google OAuth 2.0 factory — ONE Gmail grant for BOTH Google Drive and
 * Google Sheets.
 *
 * The app authenticates AS a real Gmail account (the one that owns the Drive
 * quota AND the export spreadsheets), not a service account. A single refresh
 * token (`GOOGLE_OAUTH_REFRESH_TOKEN`) is minted once via the consent flow
 * (`GET /auth/google` → `GET /oauth/callback`) and refreshes access tokens on
 * demand at runtime.
 *
 * ⚠️ Adding the `spreadsheets` scope here means any refresh token minted BEFORE
 * this change (Drive-only) must be **re-consented** to cover Sheets.
 */
@Injectable()
export class GoogleOAuthService {
  /**
   * Combined scopes for the shared account:
   *  - `drive.file`   — files/folders this app creates or opens (Drive)
   *  - `spreadsheets` — read/write the export workbook (Sheets)
   * ONE refresh token must cover BOTH.
   */
  static readonly SCOPES = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets',
  ];

  /** Cached authenticated client — Drive + Sheets share one refresh cycle. */
  private authenticated: OAuth2 | null = null;

  /** True when the OAuth app + refresh token are all present in `.env`. */
  isConfigured(): boolean {
    return (
      !!process.env.GOOGLE_OAUTH_CLIENT_ID &&
      !!process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      !!process.env.GOOGLE_OAUTH_REFRESH_TOKEN
    );
  }

  /** Bare OAuth2 client (no tokens) — used by the consent flow + token exchange. */
  buildOAuthClient(): OAuth2 {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri =
      process.env.GOOGLE_OAUTH_REDIRECT_URI ||
      'http://localhost:3000/oauth/callback';
    if (!clientId || !clientSecret) {
      throw new Error(
        'Google OAuth credentials missing — set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env',
      );
    }
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /**
   * Runtime client with the refresh token set — SHARED by Drive + Sheets so a
   * single Gmail grant authenticates both. Cached after the first build.
   */
  getAuthenticatedClient(): OAuth2 {
    if (this.authenticated) return this.authenticated;

    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    if (!refreshToken) {
      throw new Error(
        'Google OAuth refresh token missing — run the consent flow (GET /auth/google) ' +
          'with the quota-owning Gmail account and set GOOGLE_OAUTH_REFRESH_TOKEN in .env ' +
          '(the token must cover the Drive + Sheets scopes)',
      );
    }

    const client = this.buildOAuthClient();
    // Only the refresh token is needed; the library mints + refreshes the
    // access token on demand for every API call.
    client.setCredentials({ refresh_token: refreshToken });
    this.authenticated = client;
    return client;
  }

  /** Consent URL (one-time setup) — requests the COMBINED Drive + Sheets scopes.
   *  `offline` + `consent` guarantee a refresh token is returned. */
  generateAuthUrl(): string {
    return this.buildOAuthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GoogleOAuthService.SCOPES,
    });
  }

  /** Exchange the `code` from the OAuth callback for tokens (incl. the refresh
   *  token to paste into `.env`). */
  async exchangeCodeForTokens(code: string) {
    const { tokens } = await this.buildOAuthClient().getToken(code);
    return tokens;
  }
}

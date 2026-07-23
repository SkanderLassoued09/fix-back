import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { google } from 'googleapis';
import { OAuthTokenService } from '../oauth-token/oauth-token.service';
import {
  InvalidOAuthConfigError,
  MissingRefreshTokenError,
  buildInvalidGrantDiagnostic,
  extractGoogleError,
  isInvalidGrant,
  maskSecret,
} from './google-oauth.errors';

/** Instance type of the googleapis OAuth2 client (no extra dependency import). */
type OAuth2 = InstanceType<typeof google.auth.OAuth2>;

/**
 * Shared Google OAuth 2.0 factory — ONE Gmail grant for BOTH Google Drive and
 * Google Sheets.
 *
 * The app authenticates AS a real Gmail account (the one that owns the Drive
 * quota AND the export spreadsheets), not a service account. A single refresh
 * token is minted once via the consent flow (`GET /auth/google` →
 * `GET /oauth/callback`) and refreshes access tokens on demand at runtime.
 *
 * ⚠️ The refresh token now lives in **MongoDB** (collection `oauth_tokens`, via
 * `OAuthTokenService`), NOT in `.env`. Authorizing once (or re-authorizing after
 * an `invalid_grant`) persists the token to the DB and takes effect WITHOUT a
 * restart — the cached client is keyed by token value and rebuilt when the
 * stored token changes.
 *
 * Diagnostics: at boot this logs a MASKED config summary and, when a token
 * exists, proactively refreshes an access token so an `invalid_grant` surfaces
 * immediately (with an actionable message) instead of at the first upload.
 * Nothing here EVER logs a full secret — see `maskSecret`.
 */
@Injectable()
export class GoogleOAuthService implements OnModuleInit {
  private readonly logger = new Logger(GoogleOAuthService.name);

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

  /**
   * Cached authenticated client, KEYED by the refresh token value. Keeping the
   * SAME client instance while the stored token is unchanged preserves
   * googleapis' internal access-token cache (so we don't refresh on every call);
   * a token change (rotation / re-auth) invalidates the cache and rebuilds.
   */
  private cached: { client: OAuth2; token: string } | null = null;

  /**
   * CSRF `state` store for the consent flow: state → expiry epoch ms. In-memory
   * (single-instance). Multi-instance deployments would need a shared store, but
   * the consent flow is a rare, operator-driven one-shot, so this is acceptable.
   */
  private readonly states = new Map<string, number>();
  private static readonly STATE_TTL_MS = 10 * 60_000;

  constructor(private readonly tokens: OAuthTokenService) {}

  /** Read an env var trimmed — a stray trailing space/CR would corrupt a
   *  secret (e.g. a client secret) into an `invalid_grant`. */
  private env(key: string): string | undefined {
    const v = process.env[key];
    return v == null ? undefined : v.trim() || undefined;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Configuration
  // ───────────────────────────────────────────────────────────────────────

  /** True when the OAuth APP credentials (client id + secret) are present in
   *  `.env`. Sync helper — the refresh token lives in the DB, not env. */
  hasOAuthCredentials(): boolean {
    return (
      !!this.env('GOOGLE_OAUTH_CLIENT_ID') &&
      !!this.env('GOOGLE_OAUTH_CLIENT_SECRET')
    );
  }

  /** Fully configured = OAuth app creds in env AND a refresh token stored in DB
   *  (the account has been authorized at least once). Async because the token
   *  lives in Mongo now. */
  async isConfigured(): Promise<boolean> {
    if (!this.hasOAuthCredentials()) return false;
    return !!(await this.tokens.getRefreshToken());
  }

  /** The subset of required OAuth APP env vars that are missing (empty when OK).
   *  The refresh token is no longer an env key — it lives in the DB. */
  missingConfigKeys(): string[] {
    return ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'].filter(
      (k) => !this.env(k),
    );
  }

  /**
   * Startup validation + proactive token check. Deliberately NON-FATAL when the
   * token is merely absent: an unauthorized backend is the normal pre-consent
   * state (Drive/Sheets are best-effort). It ONLY hard-fails in production when
   * the OAuth APP credentials (client id/secret) are missing — that's a config
   * error, and a prod deploy silently unable to store documents is worse than a
   * loud crash.
   */
  async onModuleInit(): Promise<void> {
    const missing = this.missingConfigKeys();
    const isProd = (this.env('NODE_ENV') ?? 'development') === 'production';

    if (missing.length) {
      const err = new InvalidOAuthConfigError(missing);
      if (isProd) throw err;
      this.logger.warn(
        `Google OAuth non configuré (${missing.join(', ')}). Drive + Sheets ` +
          `désactivés jusqu'à configuration + redémarrage. ${err.message}`,
      );
      return;
    }

    // Masked config summary — proves WHICH client is loaded without leaking it.
    this.logger.log(
      `Google OAuth app configuré · client_id=${maskSecret(
        this.env('GOOGLE_OAUTH_CLIENT_ID'),
      )} · client_secret=${maskSecret(
        this.env('GOOGLE_OAUTH_CLIENT_SECRET'),
      )} · redirect_uri=${
        this.env('GOOGLE_OAUTH_REDIRECT_URI') ?? '(default)'
      }`,
    );

    // The token now lives in the DB, not env. If none is stored yet, that's the
    // normal pre-authorization state — do NOT crash, just tell the operator how
    // to connect.
    const refreshToken = await this.tokens.getRefreshToken();
    if (!refreshToken) {
      this.logger.warn(
        'Google non connecté : lancez GET /auth/google (admin) pour autoriser. ' +
          "Le refresh token sera stocké en base (collection oauth_tokens) — aucun redémarrage requis.",
      );
      return;
    }

    this.logger.log(
      `Refresh token présent en base · token=${maskSecret(refreshToken)}`,
    );

    // Proactively verify the grant so invalid_grant surfaces at boot with an
    // actionable message — best-effort (never blocks startup).
    await this.verifyConnectivity();
  }

  // ───────────────────────────────────────────────────────────────────────
  // CSRF state (consent flow)
  // ───────────────────────────────────────────────────────────────────────

  /** Mint a one-time CSRF `state` for the consent URL, remembered for 10 min. */
  createState(): string {
    this.purgeExpiredStates();
    const state = randomBytes(16).toString('hex');
    this.states.set(state, Date.now() + GoogleOAuthService.STATE_TTL_MS);
    return state;
  }

  /** Validate + consume a `state` returned by the OAuth callback: true only when
   *  it exists AND hasn't expired (then it's deleted so it can't be replayed). */
  consumeState(state: string): boolean {
    if (!state) return false;
    const expiry = this.states.get(state);
    if (expiry == null) return false;
    this.states.delete(state);
    return expiry >= Date.now();
  }

  private purgeExpiredStates(): void {
    const now = Date.now();
    for (const [state, expiry] of this.states) {
      if (expiry < now) this.states.delete(state);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Client factory
  // ───────────────────────────────────────────────────────────────────────

  /** Bare OAuth2 client (no tokens) — used by the consent flow + token exchange. */
  buildOAuthClient(): OAuth2 {
    const clientId = this.env('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = this.env('GOOGLE_OAUTH_CLIENT_SECRET');
    const redirectUri =
      this.env('GOOGLE_OAUTH_REDIRECT_URI') ||
      'http://localhost:3000/oauth/callback';
    if (!clientId || !clientSecret) {
      throw new InvalidOAuthConfigError(
        [
          !clientId && 'GOOGLE_OAUTH_CLIENT_ID',
          !clientSecret && 'GOOGLE_OAUTH_CLIENT_SECRET',
        ].filter(Boolean) as string[],
      );
    }
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /**
   * Runtime client with the refresh token set — SHARED by Drive + Sheets so a
   * single Gmail grant authenticates both. The refresh token is read from the DB
   * (collection `oauth_tokens`); the cache is keyed by token value so a
   * rotation/re-auth transparently rebuilds on the next call.
   *
   * The `tokens` event is the ONLY place a rotated refresh token could arrive;
   * we PERSIST it (never overwriting a good one with an access-token-only
   * response) and log every refresh with masked values. Persistence means a
   * rotation needs NO restart.
   */
  async getAuthenticatedClient(): Promise<OAuth2> {
    const refreshToken = await this.tokens.getRefreshToken();
    if (!refreshToken) {
      throw new MissingRefreshTokenError();
    }

    // Same token as last build → reuse the client (keeps googleapis' internal
    // access-token cache warm; avoids a rebuild + refresh on every call).
    if (this.cached && this.cached.token === refreshToken) {
      return this.cached.client;
    }

    const client = this.buildOAuthClient();
    // Only the refresh token is needed; the library mints + refreshes the
    // access token on demand for every API call.
    client.setCredentials({ refresh_token: refreshToken });

    // The mock in some unit tests has no `.on` — guard so tests stay hermetic.
    if (typeof (client as any).on === 'function') {
      (client as any).on('tokens', (tokens: any) => {
        // A refresh SUCCEEDED. Google returns a new access_token (+ expiry);
        // it returns a refresh_token ONLY on rare rotation.
        if (tokens?.refresh_token) {
          // ROTATION — persist the new token to the DB (survives restart, no
          // .env edit) and re-point the cache at it. NEVER overwrite the stored
          // refresh token with an access-token-only response.
          const rotated: string = tokens.refresh_token;
          this.tokens
            .saveRefreshToken(rotated)
            .then(() => {
              this.cached = { client, token: rotated };
              this.logger.warn(
                `Google a renvoyé un NOUVEAU refresh token (rotation) — ` +
                  `persisté en base (oauth_tokens). token=${maskSecret(rotated)}. ` +
                  `Aucun redémarrage nécessaire.`,
              );
            })
            .catch((err) =>
              this.logger.error(
                `Échec de persistance du refresh token rotaté: ${
                  (err as Error).message
                }`,
              ),
            );
          client.setCredentials({
            ...client.credentials,
            refresh_token: rotated,
          });
        }
        // Heartbeat: record the successful refresh (best-effort, can't await in
        // an event handler).
        this.tokens
          .touchRefreshed()
          .catch((err) =>
            this.logger.warn(
              `touchRefreshed a échoué: ${(err as Error).message}`,
            ),
          );
        this.logger.log(
          `Access token rafraîchi · access_token=${maskSecret(
            tokens?.access_token,
          )} · expiry=${
            tokens?.expiry_date
              ? new Date(tokens.expiry_date).toISOString()
              : '(inconnu)'
          }`,
        );
      });
    }

    this.cached = { client, token: refreshToken };
    return client;
  }

  /**
   * Persist the tokens returned by the OAuth callback code-exchange. Only saves
   * when a refresh token is present (an access-token-only response must NEVER
   * wipe a good stored token). Returns whether it saved.
   */
  async handleCallbackTokens(tokens: {
    refresh_token?: string | null;
  }): Promise<'SAVED' | 'NO_REFRESH_TOKEN'> {
    if (tokens?.refresh_token) {
      await this.tokens.saveRefreshToken(tokens.refresh_token, {
        scopes: GoogleOAuthService.SCOPES,
      });
      // Drop the cache so the next call rebuilds with the freshly-consented
      // token (takes effect immediately — no restart).
      this.resetClient();
      return 'SAVED';
    }
    return 'NO_REFRESH_TOKEN';
  }

  /**
   * Mark the connection unhealthy from an auth error (e.g. `invalid_grant`
   * surfaced during an upload). Records the actionable diagnostic in the DB and
   * drops the cached client so a re-auth rebuilds cleanly. Best-effort.
   */
  async markReauthFromError(err: unknown): Promise<void> {
    try {
      const diag = buildInvalidGrantDiagnostic(err);
      await this.tokens.markReauthRequired('google', diag.message);
    } finally {
      this.resetClient();
    }
  }

  /**
   * Force a token refresh once to validate the grant. Returns true on success.
   * On `invalid_grant` marks the connection REAUTH_REQUIRED in the DB, resets
   * the cache and logs the rich diagnostic (never a hard fail — connectivity
   * blips must not crash boot); returns false. Other errors → warn + false.
   */
  async verifyConnectivity(): Promise<boolean> {
    let client: OAuth2;
    try {
      client = await this.getAuthenticatedClient();
    } catch (err) {
      this.logger.warn(
        `Impossible de construire le client OAuth : ${(err as Error).message}`,
      );
      return false;
    }
    try {
      // getAccessToken() triggers a real refresh_token → access_token exchange.
      await client.getAccessToken();
      this.logger.log('Google OAuth vérifié — refresh token valide.');
      return true;
    } catch (err) {
      if (isInvalidGrant(err)) {
        const diag = buildInvalidGrantDiagnostic(err);
        // Persist the unhealthy state + reset the cache so a corrected token can
        // be picked up on next use.
        await this.tokens.markReauthRequired(
          'google',
          `invalid_grant (${diag.googleError})`,
        );
        this.resetClient();
        this.logger.error(
          `Google OAuth INVALIDE · google_error=${diag.googleError} ` +
            `· http=${diag.httpStatus ?? 'n/a'} · desc=${
              diag.googleErrorDescription ?? 'n/a'
            }\n${diag.message}`,
        );
        return false;
      }
      const info = extractGoogleError(err);
      this.logger.warn(
        `Vérification OAuth non concluante (probablement transitoire) · ` +
          `http=${info.httpStatus ?? 'n/a'} · ${info.message}`,
      );
      return false;
    }
  }

  /**
   * Operator-facing connection health. NOT_CONNECTED when no token is stored
   * yet; CONNECTED when a live refresh succeeds; REAUTH_REQUIRED when the stored
   * token is rejected (invalid_grant) — the operator must reconnect.
   */
  async getConnectionHealth(): Promise<{
    status: string;
    message: string;
    refreshTokenValid?: boolean;
  }> {
    const refreshToken = await this.tokens.getRefreshToken();
    if (!refreshToken) {
      return {
        status: 'NOT_CONNECTED',
        message: 'Google Drive non autorisé. Lancez /auth/google.',
      };
    }
    const ok = await this.verifyConnectivity();
    if (ok) {
      return { status: 'CONNECTED', message: 'OAuth OK', refreshTokenValid: true };
    }
    return {
      status: 'REAUTH_REQUIRED',
      message: 'Google Drive authorization expired. Please reconnect.',
      refreshTokenValid: false,
    };
  }

  /** Drop the cached client so the NEXT call rebuilds from the current stored
   *  token — used after a re-authorization / rotation without a full restart. */
  resetClient(): void {
    this.cached = null;
  }

  /** Consent URL (one-time setup) — requests the COMBINED Drive + Sheets scopes.
   *  `offline` + `consent` guarantee a refresh token is returned; `state` guards
   *  the callback against CSRF. */
  generateAuthUrl(): string {
    return this.buildOAuthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GoogleOAuthService.SCOPES,
      state: this.createState(),
    });
  }

  /** Exchange the `code` from the OAuth callback for tokens (incl. the refresh
   *  token, which the caller persists via `handleCallbackTokens`). */
  async exchangeCodeForTokens(code: string) {
    const { tokens } = await this.buildOAuthClient().getToken(code);
    return tokens;
  }
}

import {
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { RestJwtAuthGuard } from '../auth/rest-jwt-auth-guard';
import { GoogleDriveService } from './google-drive.service';
import { GoogleOAuthService } from '../google-auth/google-auth.service';
import { maskSecret } from '../google-auth/google-oauth.errors';

/**
 * OAuth 2.0 consent flow for the shared Google (Drive + Sheets) integration.
 *
 *   1. Open  GET /auth/google           → redirects to Google's consent screen
 *      (with a CSRF `state`). ⚠️ Sign in with the account that OWNS the Drive
 *      quota — uploaded files are owned by, and billed to, whichever account
 *      consents.
 *   2. After consent, Google calls GET /oauth/callback?code=…&state=… which
 *      validates the state, exchanges the code, and PERSISTS the refresh token
 *      into MongoDB (collection `oauth_tokens`).
 *   3. Done — no `.env` edit, no restart. The runtime refreshes access tokens
 *      automatically from the stored refresh token.
 *
 * Re-connecting after an `invalid_grant` (see `buildInvalidGrantDiagnostic`):
 * POST /admin/google/reauthorize (admin) returns a fresh consent URL to click.
 *
 * Security: the consent GET routes are unauthenticated (they carry no secret and
 * are guarded by the CSRF `state`); the re-authorize endpoint is behind
 * `RestJwtAuthGuard`. The refresh token is a SECRET — it lives only in the DB,
 * never in code/git/logs (always masked).
 */
@Controller()
export class GoogleDriveController {
  private readonly logger = new Logger(GoogleDriveController.name);

  constructor(
    private readonly driveService: GoogleDriveService,
    private readonly oauth: GoogleOAuthService,
  ) {}

  /**
   * Ops health check: reports the connection status (NOT_CONNECTED /
   * CONNECTED / REAUTH_REQUIRED) by triggering a real token refresh. Lets an
   * operator confirm an `invalid_grant` and get the re-auth instructions without
   * digging through logs. Never returns a secret.
   */
  @Get('oauth/health')
  async oauthHealth(@Res() res: Response) {
    const missing = this.oauth.missingConfigKeys();
    if (missing.length) {
      res.status(503).json({
        configured: false,
        missing,
        hint: 'Renseignez les variables manquantes (client id/secret) dans .env puis redémarrez.',
      });
      return;
    }
    const health = await this.oauth.getConnectionHealth();
    // CONNECTED → 200; NOT_CONNECTED / REAUTH_REQUIRED → 503 (action needed).
    const httpStatus = health.status === 'CONNECTED' ? 200 : 503;
    res.status(httpStatus).json({
      configured: true,
      status: health.status,
      refreshTokenValid: health.refreshTokenValid,
      clientId: maskSecret(process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()),
      message: health.message,
      hint:
        health.status === 'CONNECTED'
          ? 'OAuth OK — le refresh token stocké est accepté par Google.'
          : "Reconnectez-vous : GET /auth/google (compte propriétaire) ou POST /admin/google/reauthorize (admin). Détail dans les logs serveur.",
    });
  }

  @Get('auth/google')
  authGoogle(@Res() res: Response) {
    try {
      // generateAuthUrl() embeds a fresh CSRF `state` validated on callback.
      res.redirect(this.driveService.generateAuthUrl());
    } catch (err) {
      res
        .status(500)
        .send(`OAuth not configured: ${(err as Error)?.message ?? err}`);
    }
  }

  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    if (!code) {
      res.status(400).send('Missing ?code — start the flow at /auth/google');
      return;
    }
    // CSRF defence: the callback MUST carry back the exact `state` we minted for
    // the consent redirect. Missing/unknown/expired → reject.
    if (!state || !this.oauth.consumeState(state)) {
      this.logger.warn(
        'OAuth callback rejected — invalid or missing state (possible CSRF).',
      );
      res
        .status(400)
        .send(
          'Invalid or missing state — possible CSRF. Restart at /auth/google.',
        );
      return;
    }
    try {
      const tokens = await this.driveService.exchangeCodeForTokens(code);
      const result = await this.oauth.handleCallbackTokens(tokens);
      if (result === 'SAVED') {
        this.logger.log(
          'OAuth refresh token obtained and persisted to MongoDB (oauth_tokens). No restart needed.',
        );
        res
          .status(200)
          .type('html')
          .send(
            `<h3>✅ Google Drive connecté</h3>` +
              `<p>Le refresh token a été enregistré en base (MongoDB, collection ` +
              `<code>oauth_tokens</code>). <strong>Aucun redémarrage nécessaire.</strong></p>` +
              `<p>Vérifiez l'état sur <code>GET /oauth/health</code>.</p>`,
          );
      } else {
        // Google only returns a refresh token on the FIRST consent unless
        // prompt=consent forces it. We do force it, but if the account already
        // granted access without revoking, Google may omit it.
        this.logger.warn(
          'OAuth callback returned NO refresh token (already granted?). Revoke app access at https://myaccount.google.com/permissions then retry /auth/google.',
        );
        res
          .status(200)
          .type('html')
          .send(
            `<h3>⚠️ Aucun refresh token renvoyé</h3>` +
              `<p>Le compte a déjà autorisé l'app, donc Google n'a pas renvoyé de ` +
              `refresh token. Révoquez l'accès sur ` +
              `<a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a> ` +
              `puis relancez <code>/auth/google</code>.</p>`,
          );
      }
    } catch (err) {
      this.logger.error(
        `OAuth code exchange failed: ${(err as Error)?.message ?? err}`,
      );
      res
        .status(500)
        .send(`OAuth exchange failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * Admin re-authorization: returns a fresh Google consent URL (with `state`)
   * so an admin can reconnect after an `invalid_grant` WITHOUT touching `.env`.
   * Guarded by `RestJwtAuthGuard` (any authenticated user) — the project's
   * `RolesGuard` reads the GraphQL context and does not apply to a REST route,
   * so an admin-role restriction is not wired here (see report).
   */
  @Post('admin/google/reauthorize')
  @UseGuards(RestJwtAuthGuard)
  reauthorize() {
    return {
      status: 'REAUTH_REQUIRED',
      authorizeUrl: this.driveService.generateAuthUrl(),
    };
  }
}

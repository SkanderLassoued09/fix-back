import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { GoogleDriveService } from './google-drive.service';

/**
 * One-time OAuth 2.0 consent flow for the Drive integration (dev setup).
 *
 *   1. Open  GET /auth/google           → redirects to Google's consent screen.
 *      ⚠️ Sign in with the account that OWNS the Drive quota (the 400 GB one) —
 *      uploaded files will be owned by, and billed to, whichever account consents.
 *   2. After consent, Google calls GET /oauth/callback?code=… which exchanges the
 *      code for a refresh token and shows/logs it.
 *   3. Paste that refresh token into `.env` as GOOGLE_OAUTH_REFRESH_TOKEN and
 *      restart — the runtime then refreshes access tokens automatically.
 *
 * Security: these routes are unauthenticated (guards are out of scope) and only
 * meant for local dev setup (redirect_uri = localhost). The refresh token is a
 * SECRET — it lives only in `.env`, never in code/git. Run the flow once.
 */
@Controller()
export class GoogleDriveController {
  private readonly logger = new Logger(GoogleDriveController.name);

  constructor(private readonly driveService: GoogleDriveService) {}

  @Get('auth/google')
  authGoogle(@Res() res: Response) {
    try {
      res.redirect(this.driveService.generateAuthUrl());
    } catch (err) {
      res
        .status(500)
        .send(`OAuth not configured: ${(err as Error)?.message ?? err}`);
    }
  }

  @Get('oauth/callback')
  async oauthCallback(@Query('code') code: string, @Res() res: Response) {
    if (!code) {
      res.status(400).send('Missing ?code — start the flow at /auth/google');
      return;
    }
    try {
      const tokens = await this.driveService.exchangeCodeForTokens(code);
      const refresh = tokens.refresh_token;
      if (refresh) {
        // Server-side log so the dev can copy it from the console too.
        this.logger.log(
          `OAuth refresh token obtained — paste into .env GOOGLE_OAUTH_REFRESH_TOKEN:\n${refresh}`,
        );
        res
          .status(200)
          .type('html')
          .send(
            `<h3>✅ Refresh token obtenu</h3>` +
              `<p>Collez-le dans <code>.env</code> :</p>` +
              `<pre>GOOGLE_OAUTH_REFRESH_TOKEN=${refresh}</pre>` +
              `<p>Puis redémarrez le backend. (Aussi loggué côté serveur.)</p>`,
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
              `<p>Le compte a déjà autorisé l'app. Révoquez l'accès sur ` +
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
}

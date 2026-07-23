import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { maskSecret } from '../google-auth/google-oauth.errors';
import { OAuthTokenDocument } from './entities/oauth-token.entity';

/** The single provider we authenticate today. Kept as a default so every method
 *  reads naturally while leaving room for a second provider later. */
const DEFAULT_PROVIDER = 'google';

/**
 * Persistence for the shared Google OAuth refresh token (collection
 * `oauth_tokens`). Replaces the old `GOOGLE_OAUTH_REFRESH_TOKEN` env var: a
 * rotated or re-consented token is now stored here, so authorization survives a
 * restart WITHOUT editing `.env`.
 *
 * Invariants:
 *   - NEVER stores an empty/undefined token (guarded in `saveRefreshToken`).
 *   - NEVER logs the raw token — always `maskSecret`.
 */
@Injectable()
export class OAuthTokenService {
  private readonly logger = new Logger(OAuthTokenService.name);

  constructor(
    @InjectModel(OAuthTokenDocument.name)
    private readonly model: Model<OAuthTokenDocument>,
  ) {}

  /** The stored refresh token for `provider`, or null when not yet authorized. */
  async getRefreshToken(provider = DEFAULT_PROVIDER): Promise<string | null> {
    const doc = await this.model.findOne({ provider }).lean().exec();
    return doc?.refreshToken?.trim() || null;
  }

  /** The full persisted record (status/scopes/lastError…), or null. */
  async getRecord(
    provider = DEFAULT_PROVIDER,
  ): Promise<OAuthTokenDocument | null> {
    return this.model.findOne({ provider }).exec();
  }

  /**
   * Upsert the refresh token for `provider`, marking the connection healthy.
   * GUARD: refuses to persist an empty/undefined token — an access-token-only
   * refresh response must NEVER wipe a good stored refresh token.
   */
  async saveRefreshToken(
    refreshToken: string,
    opts?: { provider?: string; scopes?: string[] },
  ): Promise<void> {
    if (!refreshToken?.trim()) {
      throw new Error(
        'OAuthTokenService.saveRefreshToken: refus de stocker un refresh token vide/undefined.',
      );
    }
    const provider = opts?.provider ?? DEFAULT_PROVIDER;
    const scopes = opts?.scopes;
    await this.model
      .findOneAndUpdate(
        { provider },
        {
          refreshToken: refreshToken.trim(),
          status: 'CONNECTED',
          lastError: null,
          ...(scopes ? { scopes } : {}),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    this.logger.log(
      `Refresh token enregistré en base (provider=${provider}) · ` +
        `token=${maskSecret(refreshToken)} · status=CONNECTED` +
        (scopes ? ` · scopes=${scopes.length}` : ''),
    );
  }

  /** Flip the connection to REAUTH_REQUIRED with a diagnostic reason. Only
   *  touches an EXISTING record (no upsert — nothing to re-auth if we never
   *  had a token). */
  async markReauthRequired(
    provider = DEFAULT_PROVIDER,
    reason: string,
  ): Promise<void> {
    const res = await this.model
      .updateOne(
        { provider },
        { status: 'REAUTH_REQUIRED', lastError: reason },
      )
      .exec();
    if (res.matchedCount) {
      this.logger.warn(
        `OAuth ${provider} marqué REAUTH_REQUIRED — reconnexion nécessaire ` +
          `(GET /auth/google ou POST /admin/google/reauthorize). Raison: ${reason}`,
      );
    }
  }

  /** Best-effort: record a successful access-token refresh (health heartbeat).
   *  Swallows errors — a DB blip here must never break an upload/sync. */
  async touchRefreshed(provider = DEFAULT_PROVIDER): Promise<void> {
    try {
      await this.model
        .updateOne(
          { provider },
          { lastRefreshAt: new Date(), status: 'CONNECTED' },
        )
        .exec();
    } catch (err) {
      this.logger.warn(
        `touchRefreshed(${provider}) non fatal: ${(err as Error).message}`,
      );
    }
  }
}

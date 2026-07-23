import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Persisted OAuth refresh token — ONE document per provider (e.g. `google`).
 *
 * The refresh token used to live in `GOOGLE_OAUTH_REFRESH_TOKEN` in `.env`,
 * which meant a token rotation (or re-authorization) required editing `.env`
 * and restarting the backend. Moving it to MongoDB (collection `oauth_tokens`)
 * lets the app persist a rotated/re-consented token live — no restart, no env
 * edit — and lets it record health (`status`, `lastError`, `lastRefreshAt`) so
 * an operator can see at a glance whether Google is connected.
 *
 * NEVER log `refreshToken` raw — use `maskSecret` from `google-oauth.errors`.
 */
@Schema({ timestamps: true, collection: 'oauth_tokens' })
export class OAuthTokenDocument extends Document {
  /** Provider key — one row per provider (`google`). Unique + indexed. */
  @Prop({ required: true, unique: true, index: true })
  provider: string;

  /** The Google refresh token (SECRET — never logged raw). */
  @Prop({ required: true })
  refreshToken: string;

  /** Connection health: 'CONNECTED' | 'REAUTH_REQUIRED'. */
  @Prop({ default: 'CONNECTED' })
  status: string;

  /** Scopes the token was consented for (Drive + Sheets). */
  @Prop({ type: [String], default: [] })
  scopes: string[];

  /** Last error that flipped the token to REAUTH_REQUIRED (diagnostic text). */
  @Prop()
  lastError?: string;

  /** Last time an access token was successfully refreshed from this token. */
  @Prop()
  lastRefreshAt?: Date;
}

export const OAuthTokenSchema = SchemaFactory.createForClass(OAuthTokenDocument);
// One document per provider — enforce uniqueness at the DB level too.
OAuthTokenSchema.index({ provider: 1 }, { unique: true });

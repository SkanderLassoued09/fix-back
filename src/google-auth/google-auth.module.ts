import { Module } from '@nestjs/common';
import { OAuthTokenModule } from '../oauth-token/oauth-token.module';
import { GoogleOAuthService } from './google-auth.service';

/**
 * Shared Google OAuth 2.0 factory (one Gmail grant for Drive + Sheets).
 * Imported by both GoogleDriveModule and GoogleSheetsModule so a single refresh
 * token — covering the combined scopes — authenticates every Google API call.
 *
 * The refresh token is persisted in MongoDB (`OAuthTokenModule`, collection
 * `oauth_tokens`) rather than `.env`, so authorizing/rotating takes effect
 * without a restart.
 */
@Module({
  imports: [OAuthTokenModule],
  providers: [GoogleOAuthService],
  exports: [GoogleOAuthService],
})
export class GoogleAuthModule {}

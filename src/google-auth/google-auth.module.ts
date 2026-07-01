import { Module } from '@nestjs/common';
import { GoogleOAuthService } from './google-auth.service';

/**
 * Shared Google OAuth 2.0 factory (one Gmail grant for Drive + Sheets).
 * Imported by both GoogleDriveModule and GoogleSheetsModule so a single refresh
 * token — covering the combined scopes — authenticates every Google API call.
 */
@Module({
  providers: [GoogleOAuthService],
  exports: [GoogleOAuthService],
})
export class GoogleAuthModule {}

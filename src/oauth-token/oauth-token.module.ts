import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  OAuthTokenDocument,
  OAuthTokenSchema,
} from './entities/oauth-token.entity';
import { OAuthTokenService } from './oauth-token.service';

/**
 * Persistence for the shared Google OAuth refresh token (collection
 * `oauth_tokens`). Exported so `GoogleOAuthService` (in `GoogleAuthModule`) can
 * read/write the token — replacing the old `.env`-based `GOOGLE_OAUTH_REFRESH_TOKEN`.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OAuthTokenDocument.name, schema: OAuthTokenSchema },
    ]),
  ],
  providers: [OAuthTokenService],
  exports: [OAuthTokenService],
})
export class OAuthTokenModule {}

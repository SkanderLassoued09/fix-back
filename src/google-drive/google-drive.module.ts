import { Module } from '@nestjs/common';
import { GoogleDriveService } from './google-drive.service';
import { GoogleDriveController } from './google-drive.controller';

/**
 * Google Drive integration (OAuth 2.0). Exposes `GoogleDriveService` (folder
 * creation + uploads) for other modules, and the OAuth consent-flow endpoints
 * (`/auth/google`, `/oauth/callback`) via the controller.
 */
@Module({
  controllers: [GoogleDriveController],
  providers: [GoogleDriveService],
  exports: [GoogleDriveService],
})
export class GoogleDriveModule {}

import { Module } from '@nestjs/common';
import { GoogleDriveService } from './google-drive.service';

/**
 * Google Drive integration. Exposes `GoogleDriveService` (folder creation,
 * Shared-Drive aware) for other modules — currently the company module, which
 * auto-creates a client folder on company creation.
 */
@Module({
  providers: [GoogleDriveService],
  exports: [GoogleDriveService],
})
export class GoogleDriveModule {}

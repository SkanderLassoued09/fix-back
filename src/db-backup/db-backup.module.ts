import { Module } from '@nestjs/common';
import { DbBackupService } from './db-backup.service';
import { GoogleDriveModule } from 'src/google-drive/google-drive.module';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';

/**
 * BACKUP_DB_TO_DRIVE — nightly database backup to Google Drive.
 *
 * Reuses the EXISTING `GoogleDriveService` (same OAuth grant as the DI
 * documents — deliberately NOT a second Drive client) and the existing
 * `DiscordHookService` for the success/failure alerts. No model injection:
 * the service shells out to `mongodump`, it never reads through Mongoose.
 */
@Module({
  imports: [GoogleDriveModule, DiscordHookModule],
  providers: [DbBackupService],
  exports: [DbBackupService],
})
export class DbBackupModule {}

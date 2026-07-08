import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DiArchiveSchema } from './entities/di-archive.entity';
import { DigestSnapshotSchema } from './entities/digest-snapshot.entity';
import { DiArchiveService } from './di-archive.service';
import { DiArchiveResolver } from './di-archive.resolver';
import { DiArchiveImportService } from './import/di-archive-import.service';
import { DiArchiveImportController } from './import/di-archive-import.controller';
import { DiArchiveDigestService } from './di-archive-digest.service';
import { GoogleDriveModule } from '../google-drive/google-drive.module';
import { DiscordHookModule } from '../discord-hook/discord-hook.module';

/**
 * Standalone archive module — dedicated `di_archives` collection, no coupling
 * to the operational `Di` domain. GraphQL (list / one / create) + a separate
 * bulk .xlsx importer cloned from the DI importer + the daily incompletes
 * digest service consumed by the ACTION dispatcher.
 */
@Module({
  controllers: [DiArchiveImportController],
  providers: [
    DiArchiveResolver,
    DiArchiveService,
    DiArchiveImportService,
    DiArchiveDigestService,
  ],
  imports: [
    GoogleDriveModule,
    DiscordHookModule,
    MongooseModule.forFeature([
      { name: 'DiArchive', schema: DiArchiveSchema },
      // Digest trends — one row per business day (Tunis-based),
      // upserted at each digest run for day / week deltas.
      { name: 'DigestSnapshot', schema: DigestSnapshotSchema },
    ]),
  ],
  exports: [DiArchiveService, DiArchiveDigestService],
})
export class DiArchiveModule {}

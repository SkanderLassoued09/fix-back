import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DiArchiveSchema } from './entities/di-archive.entity';
import { DiArchiveService } from './di-archive.service';
import { DiArchiveResolver } from './di-archive.resolver';
import { DiArchiveImportService } from './import/di-archive-import.service';
import { DiArchiveImportController } from './import/di-archive-import.controller';
import { GoogleDriveModule } from '../google-drive/google-drive.module';

/**
 * Standalone archive module — dedicated `di_archives` collection, no coupling
 * to the operational `Di` domain. GraphQL (list / one / create) + a separate
 * bulk .xlsx importer cloned from the DI importer.
 */
@Module({
  controllers: [DiArchiveImportController],
  providers: [DiArchiveResolver, DiArchiveService, DiArchiveImportService],
  imports: [
    GoogleDriveModule,
    MongooseModule.forFeature([
      { name: 'DiArchive', schema: DiArchiveSchema },
    ]),
  ],
  exports: [DiArchiveService],
})
export class DiArchiveModule {}

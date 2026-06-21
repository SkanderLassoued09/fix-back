import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { Di, DiSchema } from 'src/di/entities/di.entity';
import { Stat, StatSchema } from 'src/stat/entities/stat.entity';
import { GoogleSheetsClient } from './google-sheets.client';
import { DiSheetMapper } from './mappers/di-sheet.mapper';
import { ActionsEnCoursSheetMapper } from './mappers/actions-en-cours-sheet.mapper';
import { SHEET_MAPPERS } from './mappers/google-sheet-mapper.interface';
import { StatsSheetMapper } from './mappers/stats-sheet.mapper';
import { SheetSyncScheduler } from './sheet-sync.scheduler';
import { SheetSyncService } from './sheet-sync.service';

/**
 * Google Sheets sync module.
 *
 * Registers:
 *   - GoogleSheetsClient (auth + append + retry)
 *   - The two concrete mappers (DI + Stats) — each schema-injects what it
 *     needs (Di model / Stat model) so the module's own Mongoose surface
 *     stays explicit and small.
 *   - SHEET_MAPPERS multi-provider — orchestrator depends on the array,
 *     not on individual mappers. Adding a future mapper = add the class
 *     to `mappers` + the factory array, nothing else.
 *   - SheetSyncService (orchestrator) — pure orchestration, no DB/HTTP.
 *   - SheetSyncScheduler — cron-only, delegates to the service.
 *
 * Exports SheetSyncService so the ACTION runtime (AppCronService.runAction)
 * can trigger a manual run via `ACTION=SYNC_GOOGLE_SHEETS`.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      { name: Di.name, schema: DiSchema },
      { name: Stat.name, schema: StatSchema },
    ]),
  ],
  providers: [
    GoogleSheetsClient,
    DiSheetMapper,
    StatsSheetMapper,
    ActionsEnCoursSheetMapper,
    {
      provide: SHEET_MAPPERS,
      useFactory: (
        di: DiSheetMapper,
        stats: StatsSheetMapper,
        actions: ActionsEnCoursSheetMapper,
      ) => [di, stats, actions],
      inject: [DiSheetMapper, StatsSheetMapper, ActionsEnCoursSheetMapper],
    },
    SheetSyncService,
    SheetSyncScheduler,
  ],
  exports: [SheetSyncService],
})
export class GoogleSheetsModule {}

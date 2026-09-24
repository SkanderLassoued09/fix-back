import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Di, DiSchema } from 'src/di/entities/di.entity';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import { GoogleSheetsModule } from 'src/google-sheets/google-sheets.module';
import { DiLogsSchema, LogsDi } from 'src/logs-di/entities/logs-di.entity';
import { Profile, ProfileSchema } from 'src/profile/entities/profile.entity';
import { Stat, StatSchema } from 'src/stat/entities/stat.entity';
import { ActionsEnCoursExportService } from './actions-en-cours-export.service';

/**
 * EXPORT_ACTIONS_EN_COURS — onglet annuel « ACTIONS {année} » du Google Sheet
 * ACTIONS EN COURS, généré depuis l'ERP (remplace l'Excel tenu à la main). Planifié à 12 h et
 * 17 h par `AppCronService`, qui l'expose aussi en ACTION manuelle.
 */
@Module({
  imports: [
    GoogleSheetsModule,
    DiscordHookModule,
    MongooseModule.forFeature([
      { name: Di.name, schema: DiSchema },
      { name: LogsDi.name, schema: DiLogsSchema },
      { name: Stat.name, schema: StatSchema },
      { name: Profile.name, schema: ProfileSchema },
    ]),
  ],
  providers: [ActionsEnCoursExportService],
  exports: [ActionsEnCoursExportService],
})
export class ActionsEnCoursModule {}

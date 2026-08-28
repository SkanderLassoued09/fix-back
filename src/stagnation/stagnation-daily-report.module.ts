import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GoogleSheetsModule } from 'src/google-sheets/google-sheets.module';
import { NotificationModule } from 'src/notifications/notification.module';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import { StagnationModule } from './stagnation.module';
import { StagnationDailyReportService } from './stagnation-daily-report.service';
import {
  StagnationDispatch,
  StagnationDispatchSchema,
} from './entities/stagnation-dispatch.entity';

/**
 * Rapport quotidien de stagnation (24h) → feuille Google + notification ERP
 * (DAILY_REMINDER) + Discord APP_ALERT. Module SÉPARÉ pour garder
 * `StagnationModule` minimal (boot ACTION) ; il réutilise l'infra existante
 * (Sheets client, NotificationService, DiscordHook) sans la dupliquer.
 * Importé UNIQUEMENT par le CronModule (orchestrateur).
 */
@Module({
  imports: [
    StagnationModule,
    GoogleSheetsModule,
    NotificationModule,
    DiscordHookModule,
    MongooseModule.forFeature([
      { name: StagnationDispatch.name, schema: StagnationDispatchSchema },
    ]),
  ],
  providers: [StagnationDailyReportService],
  exports: [StagnationDailyReportService],
})
export class StagnationDailyReportModule {}

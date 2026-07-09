import { Module } from '@nestjs/common';
import { AppCronService } from './cron.service';
import { ScheduleModule } from '@nestjs/schedule';
import { DiModule } from 'src/di/di.module';
import { NotificationsGateway } from 'src/notification.gateway';
import { AuditModule } from 'src/audit/audit.module';
import { StagnationModule } from 'src/stagnation/stagnation.module';
import { GoogleSheetsModule } from 'src/google-sheets/google-sheets.module';
import { JiraCronNotificationModule } from 'src/jira-cron-notification/jira-cron-notification.module';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import { DiArchiveModule } from 'src/di-archive/di-archive.module';

@Module({
  imports: [
    DiModule,
    AuditModule,
    StagnationModule,
    GoogleSheetsModule,
    JiraCronNotificationModule,
    DiscordHookModule,
    // Exposes DiArchiveDigestService, consumed by
    // AppCronService.triggerDiArchiveIncompletesDigest.
    DiArchiveModule,
    ScheduleModule.forRoot(),
  ],
  providers: [AppCronService, NotificationsGateway],
})
export class CronModule {}

import { Module } from '@nestjs/common';
import { AppCronService } from './cron.service';
import { ScheduleModule } from '@nestjs/schedule';
import { DiModule } from 'src/di/di.module';
import { NotificationsGateway } from 'src/notification.gateway';
import { AuditModule } from 'src/audit/audit.module';
import { StagnationModule } from 'src/stagnation/stagnation.module';
import { GoogleSheetsModule } from 'src/google-sheets/google-sheets.module';

@Module({
  imports: [
    DiModule,
    AuditModule,
    StagnationModule,
    GoogleSheetsModule,
    ScheduleModule.forRoot(),
  ],
  providers: [AppCronService, NotificationsGateway],
})
export class CronModule {}

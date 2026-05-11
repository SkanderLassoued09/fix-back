import { Module } from '@nestjs/common';
import { AppCronService } from './cron.service';
import { ScheduleModule } from '@nestjs/schedule';
import { DiModule } from 'src/di/di.module';
import { NotificationsGateway } from 'src/notification.gateway';
import { AuditModule } from 'src/audit/audit.module';
import { StagnationModule } from 'src/stagnation/stagnation.module';

@Module({
  imports: [DiModule, AuditModule, StagnationModule, ScheduleModule.forRoot()],
  providers: [AppCronService, NotificationsGateway],
})
export class CronModule {}

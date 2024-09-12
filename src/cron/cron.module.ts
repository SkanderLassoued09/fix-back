import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { ScheduleModule } from '@nestjs/schedule';
import { DiModule } from 'src/di/di.module';
import { NotificationsGateway } from 'src/notification.gateway';
import { AuditService } from 'src/audit/audit.service';
import { AuditModule } from 'src/audit/audit.module';

@Module({
  imports: [DiModule, AuditModule, ScheduleModule.forRoot()],
  providers: [CronService, NotificationsGateway],
})
export class CronModule {}

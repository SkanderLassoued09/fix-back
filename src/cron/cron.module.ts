import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { ScheduleModule } from '@nestjs/schedule';
import { DiModule } from 'src/di/di.module';
import { NotificationsGateway } from 'src/notification.gateway';

@Module({
  imports: [DiModule, ScheduleModule.forRoot()],
  providers: [CronService, NotificationsGateway],
})
export class CronModule {}

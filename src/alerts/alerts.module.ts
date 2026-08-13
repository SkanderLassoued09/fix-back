import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import { DiAlertResolver } from './alerts.resolver';
import { DiAlertService } from './alerts.service';
import { DiAlertSchema } from './entities/di-alert.entity';
import { NotificationModule } from 'src/notifications/notification.module';

/**
 * Alerts module. Generators (stagnation today, future operational monitors
 * tomorrow) consume `DiAlertService` to persist alerts and fan out the
 * Discord side-effect. No WebSocket dependency — runs identically in
 * NORMAL and ACTION runtime modes.
 */
@Module({
  imports: [
    DiscordHookModule,
    NotificationModule,
    MongooseModule.forFeature([{ name: 'DiAlert', schema: DiAlertSchema }]),
  ],
  providers: [DiAlertService, DiAlertResolver],
  exports: [DiAlertService],
})
export class AlertsModule {}

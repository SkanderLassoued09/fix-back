import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsGateway } from '../notification.gateway';
import { ProfileSchema } from '../profile/entities/profile.entity';
import { NotificationService } from './notification.service';
import { NotificationResolver } from './notification.resolver';
import { SystemEventSchema } from './entities/system-event.entity';
import { NotificationSchema } from './entities/notification.entity';

/**
 * Système de notifications + historique ERP (v1).
 * Exporte `NotificationService` : les modules métier (di, alerts, …) l'importent
 * pour émettre via l'unique point central `emit()`.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'SystemEvent', schema: SystemEventSchema },
      { name: 'Notification', schema: NotificationSchema },
      { name: 'Profile', schema: ProfileSchema },
    ]),
  ],
  providers: [NotificationService, NotificationResolver, NotificationsGateway],
  exports: [NotificationService],
})
export class NotificationModule {}

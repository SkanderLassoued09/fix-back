import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationSchema } from 'src/notifications/entities/notification.entity';
import { DiSchema } from 'src/di/entities/di.entity';
import { DiLogsSchema } from 'src/logs-di/entities/logs-di.entity';
import { NotificationPurgeService } from './notification-purge.service';

/**
 * Purge quotidienne de la cloche (03 h Africa/Tunis) : ne conserve que les
 * 3 derniers jours, en épargnant les relances BL non satisfaites.
 *
 * Module SÉPARÉ et minimal — il enregistre lui-même les trois modèles dont il a
 * besoin plutôt que d'importer `NotificationModule`/`DiModule`/`LogsDiModule`,
 * ce qui évite toute dépendance circulaire avec le CronModule (même parti pris
 * que `SessionCleanupModule`). Importé UNIQUEMENT par le CronModule.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Notification', schema: NotificationSchema },
      { name: 'Di', schema: DiSchema },
      { name: 'LogsDi', schema: DiLogsSchema },
    ]),
  ],
  providers: [NotificationPurgeService],
  exports: [NotificationPurgeService],
})
export class NotificationPurgeModule {}

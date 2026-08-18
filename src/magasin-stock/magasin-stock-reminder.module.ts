import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationModule } from 'src/notifications/notification.module';
import {
  Composant,
  ComposantSchema,
} from 'src/composant/entities/composant.entity';
import { MagasinStockReminderService } from './magasin-stock-reminder.service';

/**
 * Rappel quotidien de stock magasin (16:00 Africa/Tunis) → notification ERP
 * (rôle Magasin). Module SÉPARÉ, minimal : réutilise le modèle `Composant` et
 * `NotificationService` existants. Importé UNIQUEMENT par le CronModule.
 */
@Module({
  imports: [
    NotificationModule,
    MongooseModule.forFeature([
      { name: Composant.name, schema: ComposantSchema },
    ]),
  ],
  providers: [MagasinStockReminderService],
  exports: [MagasinStockReminderService],
})
export class MagasinStockReminderModule {}

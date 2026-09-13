import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationModule } from 'src/notifications/notification.module';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import {
  Composant,
  ComposantSchema,
} from 'src/composant/entities/composant.entity';
import { MagasinStockReminderService } from './magasin-stock-reminder.service';

/**
 * Rappel matinal du magasin (08:00 Africa/Tunis, lun–ven) → notification ERP
 * (rôle Magasin) + post Discord. Module SÉPARÉ, minimal : réutilise le modèle
 * `Composant`, `NotificationService` et `DiscordHookService` existants. Importé
 * UNIQUEMENT par le CronModule (qui importe déjà DiscordHookModule — pas de
 * cycle, DiscordHookModule n'importe aucun de ces deux modules).
 */
@Module({
  imports: [
    NotificationModule,
    DiscordHookModule,
    MongooseModule.forFeature([
      { name: Composant.name, schema: ComposantSchema },
    ]),
  ],
  providers: [MagasinStockReminderService],
  exports: [MagasinStockReminderService],
})
export class MagasinStockReminderModule {}

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Composant, ComposantDocument } from '../composant/entities/composant.entity';
import { NotificationService } from '../notifications/notification.service';

/**
 * RAPPEL QUOTIDIEN DE STOCK MAGASIN — alerte le rôle Magasin sur les composants
 * suivis en stock (`status_composant ∈ {En stock, EnStock}`) qui sont EN RUPTURE
 * (`quantity_stocked ≤ 0`) ou BIENTÔT VIDES (`0 < quantity_stocked ≤ SEUIL`).
 *
 * Déclenché par le cron de 16:00 Africa/Tunis (`AppCronService`) et par l'ACTION
 * runtime `MAGASIN_STOCK_REMINDER`. Réutilise l'infra existante
 * (`NotificationService.emit` → cloche/toast/son), sans dupliquer.
 *
 * C'est un RAPPEL : il est censé re-partir chaque jour tant que du stock est bas
 * (pas d'idempotence inter-jours). UN SEUL résumé ERP par exécution (pas une
 * notif par pièce) pour ne pas noyer la cloche. Les pièces Interne/Externe
 * (sourcées au coup par coup, non stockées) sont ignorées.
 */
@Injectable()
export class MagasinStockReminderService {
  private readonly logger = new Logger(MagasinStockReminderService.name);

  /** Rôles destinataires — magasin uniquement (in-app, pas de Discord). */
  private static readonly ROLES = ['Magasin'];
  /** Nombre d'exemples nommés dans le message de la cloche. */
  private static readonly EXAMPLES = 10;

  constructor(
    @InjectModel(Composant.name)
    private readonly composantModel: Model<ComposantDocument>,
    private readonly notificationService: NotificationService,
  ) {}

  /** Seuil « bientôt vide » — global, configurable (`STOCK_LOW_THRESHOLD`),
   *  défaut 5. Une valeur ≤ 0 désactive le palier « bientôt vide » (rupture seule). */
  private threshold(): number {
    const raw = Number(process.env.STOCK_LOW_THRESHOLD);
    return Number.isFinite(raw) ? raw : 5;
  }

  private fmt(
    items: Array<{ name?: string; quantity_stocked?: number }>,
  ): string {
    return items
      .slice(0, MagasinStockReminderService.EXAMPLES)
      .map((c) => `${c.name ?? '?'} (${c.quantity_stocked ?? 0})`)
      .join(', ');
  }

  /**
   * Exécute le rappel. Retourne un résumé pour le log du cron.
   */
  async run(): Promise<{
    threshold: number;
    rupture: number;
    low: number;
    notified: boolean;
  }> {
    const threshold = this.threshold();
    this.logger.log(`START magasin stock reminder · seuil=${threshold}`);

    // Pièces suivies en stock, non supprimées, à ≤ seuil (rupture incluse).
    const parts = (await this.composantModel
      .find(
        {
          status_composant: { $in: ['En stock', 'EnStock'] },
          isDeleted: { $ne: true },
          quantity_stocked: { $lte: threshold },
        },
        { name: 1, quantity_stocked: 1 },
      )
      .sort({ quantity_stocked: 1 })
      .lean()) as Array<{ name?: string; quantity_stocked?: number }>;

    const rupture = parts.filter((c) => !(Number(c.quantity_stocked) > 0));
    const low = parts.filter((c) => {
      const q = Number(c.quantity_stocked);
      return q > 0 && q <= threshold;
    });

    if (!rupture.length && !low.length) {
      this.logger.log(
        `END magasin stock reminder · seuil=${threshold} · rien à signaler`,
      );
      return { threshold, rupture: 0, low: 0, notified: false };
    }

    const lines: string[] = [];
    if (rupture.length) {
      lines.push(`🔴 Rupture (${rupture.length}) : ${this.fmt(rupture)}`);
    }
    if (low.length) {
      lines.push(
        `🟠 Bientôt vide ≤${threshold} (${low.length}) : ${this.fmt(low)}`,
      );
    }
    const message = `Rappel stock magasin — ${lines.join(' · ')}`;

    try {
      await this.notificationService.emit({
        type: 'MAGASIN_STOCK_LOW',
        diId: null,
        actorId: null,
        message,
        payload: {
          threshold,
          rupture: rupture.map((c) => ({
            name: c.name,
            quantity: c.quantity_stocked ?? 0,
          })),
          low: low.map((c) => ({
            name: c.name,
            quantity: c.quantity_stocked ?? 0,
          })),
        },
        notify: { roles: MagasinStockReminderService.ROLES },
      });
    } catch (err) {
      this.logger.warn(
        `MAGASIN_STOCK_LOW emit échoué: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `END magasin stock reminder · seuil=${threshold} · rupture=${rupture.length} · bientôt-vide=${low.length}`,
    );
    return {
      threshold,
      rupture: rupture.length,
      low: low.length,
      notified: true,
    };
  }
}

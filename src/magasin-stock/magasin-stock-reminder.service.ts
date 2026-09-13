import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Composant, ComposantDocument } from '../composant/entities/composant.entity';
import { NotificationService } from '../notifications/notification.service';
import { DiscordHookService } from '../discord-hook/discord-hook.service';

/**
 * RAPPEL MATINAL DU MAGASIN — 08:00 Africa/Tunis, du lundi au vendredi
 * (`AppCronService`), ou à la demande via l'ACTION runtime
 * `MAGASIN_STOCK_REMINDER`. Deux sujets, deux notifications au maximum :
 *
 *   §1 STOCK BAS — composants suivis en stock (`status_composant ∈ {En stock,
 *      EnStock}`) EN RUPTURE (`quantity_stocked ≤ 0`) ou BIENTÔT VIDES
 *      (`0 < quantity_stocked ≤ SEUIL`). Type `MAGASIN_STOCK_LOW`.
 *
 *   §2 FICHES À COMPLÉTER — composants dont `status_composant`, `prix_achat`,
 *      `prix_vente` ou `quantity_stocked` est vide : ils cassent la cohérence
 *      de la base. Type `MAGASIN_STOCK_INCOMPLETE`.
 *
 * §2 est la CAUSE de l'angle mort de §1 : une fiche au statut vide n'est ni
 * décrémentée ni surveillée, donc une pièce réellement stockée y devient
 * invisible. Le périmètre de §1 n'est VOLONTAIREMENT pas élargi — on ne devine
 * pas qu'une fiche est stockée, on demande au magasin de le déclarer. Les
 * pièces Interne/Externe (sourcées au coup par coup) restent hors de §1.
 *
 * C'est un RAPPEL : il re-part chaque matin tant qu'il reste quelque chose à
 * traiter (pas d'idempotence inter-jours). UN SEUL résumé par sujet (jamais une
 * notif par pièce) pour ne pas noyer la cloche, puis UN post Discord qui
 * reprend les deux. Un sujet propre n'émet rien.
 */

/** Valeurs comptant comme vides pour un champ texte. Le littéral `'undefined'`
 *  est INDISPENSABLE : des dizaines de fiches le portent, écrit par une
 *  interpolation non gardée côté front (cf. `migration
 *  002-fix-category-label-pollution.js`). Sans lui la moitié du catalogue
 *  passerait pour renseignée. */
const BLANK = new Set(['', 'undefined', 'null', 'NaN']);

const isBlankStr = (v: unknown): boolean =>
  v == null || BLANK.has(String(v).trim());

/** `0` est une valeur RENSEIGNÉE (prix nul, stock épuisé) — jamais « vide ».
 *  Seuls l'absence, `null` et une valeur non numérique comptent comme vides. */
const isBlankNum = (v: unknown): boolean =>
  typeof v !== 'number' || !Number.isFinite(v);

/** Fiche réduite aux champs inspectés, quantité normalisée (`null` = absente). */
interface NamedPart {
  name?: string;
  quantity: number | null;
}

export interface StockIncompleteCounts {
  /** Fiches au `status_composant` vide. */
  status: number;
  /** Fiches sans `prix_achat` et/ou sans `prix_vente`. */
  price: number;
  /** Fiches sans `quantity_stocked`. */
  qty: number;
  /** Fiches DISTINCTES concernées par au moins un motif (pas la somme). */
  affected: number;
}

export interface StockReminderResult {
  threshold: number;
  rupture: number;
  low: number;
  notified: boolean;
  incomplete: StockIncompleteCounts;
  incompleteNotified: boolean;
  discordSent: boolean;
}

@Injectable()
export class MagasinStockReminderService {
  private readonly logger = new Logger(MagasinStockReminderService.name);

  /** Rôles destinataires de la cloche — magasin uniquement. */
  private static readonly ROLES = ['Magasin'];
  /** Nombre d'exemples nommés dans les messages. */
  private static readonly EXAMPLES = 10;

  constructor(
    @InjectModel(Composant.name)
    private readonly composantModel: Model<ComposantDocument>,
    private readonly notificationService: NotificationService,
    private readonly discordHookService: DiscordHookService,
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
   * Exemples nommés pour §2.
   *
   * `showQty` annote chaque nom de sa quantité — utile pour le motif « statut
   * vide », où elle montre le stock réel resté invisible (`4,7µF400V (15)`).
   * On l'ÉTEINT pour le motif « prix » : à côté d'un libellé « Prix », un
   * « 7805 (0) » se lit comme un prix nul alors que c'est une quantité.
   *
   * La quantité n'est affichée que si elle est RENSEIGNÉE : « (0) » et « pas de
   * quantité » ne disent pas la même chose, et c'est précisément la distinction
   * que le rappel demande de corriger.
   */
  private fmtParts(items: NamedPart[], showQty = true): string {
    return items
      .slice(0, MagasinStockReminderService.EXAMPLES)
      .map((c) =>
        showQty && typeof c.quantity === 'number'
          ? `${c.name ?? '?'} (${c.quantity})`
          : `${c.name ?? '?'}`,
      )
      .join(', ');
  }

  /**
   * §2 — fiches incomplètes. Un seul balayage du catalogue vivant, projection
   * réduite, classement en mémoire : le catalogue est petit, le job tourne une
   * fois par jour, et un `$not: { $type: 'number' }` côté Mongo matcherait
   * aussi les champs absents — la lecture en JS est plus juste et plus lisible.
   */
  private async detectIncomplete(): Promise<
    StockIncompleteCounts & {
      statusMissing: NamedPart[];
      priceMissing: NamedPart[];
      qtyMissing: NamedPart[];
    }
  > {
    const parts = (await this.composantModel
      .find(
        { isDeleted: { $ne: true } },
        {
          name: 1,
          status_composant: 1,
          prix_achat: 1,
          prix_vente: 1,
          quantity_stocked: 1,
        },
      )
      .lean()) as Array<Record<string, unknown>>;

    const statusMissing: NamedPart[] = [];
    const priceMissing: NamedPart[] = [];
    const qtyMissing: NamedPart[] = [];
    let affected = 0;

    for (const p of parts ?? []) {
      const noStatus = isBlankStr(p.status_composant);
      const noPrice = isBlankNum(p.prix_achat) || isBlankNum(p.prix_vente);
      const noQty = isBlankNum(p.quantity_stocked);
      if (!noStatus && !noPrice && !noQty) continue;

      affected++;
      const row: NamedPart = {
        name: typeof p.name === 'string' ? p.name : undefined,
        quantity: isBlankNum(p.quantity_stocked)
          ? null
          : (p.quantity_stocked as number),
      };
      if (noStatus) statusMissing.push(row);
      if (noPrice) priceMissing.push(row);
      if (noQty) qtyMissing.push(row);
    }

    return {
      status: statusMissing.length,
      price: priceMissing.length,
      qty: qtyMissing.length,
      affected,
      statusMissing,
      priceMissing,
      qtyMissing,
    };
  }

  /**
   * Exécute le rappel. Retourne un résumé pour le log du cron.
   */
  async run(): Promise<StockReminderResult> {
    const threshold = this.threshold();
    this.logger.log(`START magasin stock reminder · seuil=${threshold}`);

    // ── §1 Stock bas ────────────────────────────────────────────────────────
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

    let notified = false;
    if (rupture.length || low.length) {
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
        notified = true;
      } catch (err) {
        this.logger.warn(
          `MAGASIN_STOCK_LOW emit échoué: ${(err as Error).message}`,
        );
      }
    }

    // ── §2 Fiches à compléter ───────────────────────────────────────────────
    const inc = await this.detectIncomplete();

    let incompleteNotified = false;
    if (inc.affected > 0) {
      const lines: string[] = [];
      if (inc.status) {
        lines.push(
          `🏷️ Statut (${inc.status}) : ${this.fmtParts(inc.statusMissing)}`,
        );
      }
      if (inc.price) {
        lines.push(
          `💰 Prix (${inc.price}) : ${this.fmtParts(inc.priceMissing, false)}`,
        );
      }
      if (inc.qty) {
        lines.push(
          `📦 Quantité (${inc.qty}) : ${this.fmtParts(inc.qtyMissing)}`,
        );
      }
      const message = `Composants à compléter (${inc.affected}) — ${lines.join(
        ' · ',
      )}`;

      try {
        await this.notificationService.emit({
          type: 'MAGASIN_STOCK_INCOMPLETE',
          diId: null,
          actorId: null,
          message,
          payload: {
            affected: inc.affected,
            statusMissing: inc.statusMissing,
            priceMissing: inc.priceMissing,
            qtyMissing: inc.qtyMissing,
          },
          notify: { roles: MagasinStockReminderService.ROLES },
        });
        incompleteNotified = true;
      } catch (err) {
        this.logger.warn(
          `MAGASIN_STOCK_INCOMPLETE emit échoué: ${(err as Error).message}`,
        );
      }
    }

    // ── Discord — best-effort, APRÈS la cloche ──────────────────────────────
    // Une panne de webhook ne doit jamais faire perdre la notification ERP.
    let discordSent = false;
    if (rupture.length || low.length || inc.affected > 0) {
      try {
        await this.discordHookService.sendMagasinStockReminder({
          threshold,
          rupture: { count: rupture.length, examples: this.fmt(rupture) },
          low: { count: low.length, examples: this.fmt(low) },
          incomplete: {
            affected: inc.affected,
            status: inc.status,
            price: inc.price,
            qty: inc.qty,
            examples: this.fmtParts(inc.statusMissing),
          },
        });
        discordSent = true;
      } catch (err) {
        this.logger.warn(
          `Discord rappel stock magasin échoué: ${(err as Error).message}`,
        );
      }
    }

    if (!notified && !incompleteNotified) {
      this.logger.log(
        `END magasin stock reminder · seuil=${threshold} · rien à signaler`,
      );
    } else {
      this.logger.log(
        `END magasin stock reminder · seuil=${threshold} · rupture=${rupture.length} · ` +
          `bientôt-vide=${low.length} · à-compléter=${inc.affected} ` +
          `(statut=${inc.status} prix=${inc.price} quantité=${inc.qty})`,
      );
    }

    return {
      threshold,
      rupture: rupture.length,
      low: low.length,
      notified,
      incomplete: {
        status: inc.status,
        price: inc.price,
        qty: inc.qty,
        affected: inc.affected,
      },
      incompleteNotified,
      discordSent,
    };
  }
}

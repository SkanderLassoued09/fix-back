import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiDocument } from 'src/di/entities/di.entity';
import {
  firstNonEmpty,
  formatDateForSheet,
  safeCell,
} from '../utils/format.util';
import { IGoogleSheetMapper } from './google-sheet-mapper.interface';

/**
 * DI → 21-column sheet row.
 *
 * Header (must stay in sync with the spreadsheet's row 1):
 *   N° DI | Désignation | Client | Date Diagnostic | Technicien |
 *   Début Diagnostic | Fin Diagnostic | Devis | Date Envoi Devis |
 *   Bon de Commande | Date Réception BC | Date Réparation |
 *   Début Réparation | Fin Réparation | Action du jour | Blocage |
 *   Statut PDR | Date Livraison Prévue | Date Réception PDR |
 *   Observations | État
 *
 * Field provenance rules (strict, no fabrication):
 *   - Real DB field present  → real value, dates as YYYY-MM-DD HH:mm
 *   - DB field missing       → "" (empty string)
 *   - DB field exists but    → "N/A"
 *     unparseable
 *
 * Several columns (Début/Fin Diagnostic, Date Envoi Devis, Date Réception
 * BC, Date Réparation, Début Réparation, Action du jour, Date Livraison
 * Prévue) have NO dedicated DB column today. They render as "" — the
 * sheet stays accurate. Adding those fields later means populating the
 * DI document; this mapper picks them up automatically.
 *
 * Sync scope: DIs updated in the last 24h (incremental, daily cron).
 * Naturally avoids duplicates between runs without a sync-state table.
 */
@Injectable()
export class DiSheetMapper implements IGoogleSheetMapper<DiDocument> {
  private readonly logger = new Logger(DiSheetMapper.name);

  readonly entityName = 'DI';
  readonly range = `${process.env.GOOGLE_SHEETS_TAB ?? 'DI'}!A:U`;
  readonly headerRow = [
    'N° DI',
    'Désignation',
    'Client',
    'Date Diagnostic',
    'Technicien',
    'Début Diagnostic',
    'Fin Diagnostic',
    'Devis',
    'Date Envoi Devis',
    'Bon de Commande',
    'Date Réception BC',
    'Date Réparation',
    'Début Réparation',
    'Fin Réparation',
    'Action du jour',
    'Blocage',
    'Statut PDR',
    'Date Livraison Prévue',
    'Date Réception PDR',
    'Observations',
    'État',
  ];

  constructor(@InjectModel('Di') private readonly diModel: Model<DiDocument>) {}

  async fetch(): Promise<DiDocument[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.diModel
      .find({
        isDeleted: { $ne: true },
        $or: [{ updatedAt: { $gte: since } }, { createdAt: { $gte: since } }],
      })
      .populate('client_id', 'first_name last_name')
      .populate('company_id', 'name')
      .populate('createdBy', 'firstName lastName')
      .populate('location_id', 'location_name')
      .populate('di_category_id', 'category')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  mapToSheetRow(di: DiDocument): string[] {
    try {
      const clientName = this.buildClientName(di);
      const blocage = this.buildBlocageLabel(di.status);
      const pdrStatus = firstNonEmpty(
        (di as any).confirmationComposant,
        (di as any).gotComposantFromMagasin,
      );
      const observations = firstNonEmpty(
        (di as any).remarque_coordinator,
        (di as any).remarque_manager,
        (di as any).remarque_admin_manager,
      );

      // Fin Réparation: only set when DI actually reached FINISHED, in which
      // case statusUpdatedAt (Phase 1 backend stamp) marks the moment.
      const finReparation =
        di.status === 'FINISHED' && (di as any).statusUpdatedAt
          ? formatDateForSheet((di as any).statusUpdatedAt)
          : '';

      return [
        safeCell(di._idnum),                                  // 1  N° DI
        safeCell(di.title),                                   // 2  Désignation
        clientName,                                           // 3  Client
        formatDateForSheet(di.createdAt),                     // 4  Date Diagnostic (proxy: DI open)
        '',                                                   // 5  Technicien — populated via Stat join below if needed
        '',                                                   // 6  Début Diagnostic — no DB field
        '',                                                   // 7  Fin Diagnostic — no DB field
        safeCell(di.devis),                                   // 8  Devis
        '',                                                   // 9  Date Envoi Devis — no DB field
        safeCell(di.bon_de_commande),                         // 10 Bon de Commande
        '',                                                   // 11 Date Réception BC — no DB field
        '',                                                   // 12 Date Réparation — no DB field
        '',                                                   // 13 Début Réparation — no DB field
        finReparation,                                        // 14 Fin Réparation
        '',                                                   // 15 Action du jour — no DB field
        blocage,                                              // 16 Blocage (derived from pause statuses)
        pdrStatus,                                            // 17 Statut PDR
        '',                                                   // 18 Date Livraison Prévue — no DB field
        formatDateForSheet((di as any).componentsConfirmedAt), // 19 Date Réception PDR
        observations,                                         // 20 Observations
        safeCell(di.status),                                  // 21 État
      ];
    } catch (err) {
      this.logger.warn(
        `mapToSheetRow failed for DI=${di?._id}: ${(err as Error).message}. ` +
          `Falling back to a row of "N/A" placeholders.`,
      );
      // Fail-safe: never lose a row. 21 N/A cells keep the column shape so
      // the sheet stays well-formed even when one DI has corrupted data.
      return new Array(21).fill('N/A');
    }
  }

  uniqueKey(di: DiDocument): string | null {
    return di?._idnum ?? di?._id ?? null;
  }

  // ─── private ─────────────────────────────────────────────────────────

  /**
   * Client column rules:
   *   1. populated client_id object → "first_name last_name"
   *   2. populated company_id object → "name"
   *   3. raw string fallbacks (when populate didn't run)
   *   4. ""
   */
  private buildClientName(di: DiDocument): string {
    const c: any = di.client_id;
    if (c && typeof c === 'object') {
      const full = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
      if (full) return full;
    }
    const co: any = di.company_id;
    if (co && typeof co === 'object' && co.name) return String(co.name);
    return firstNonEmpty(
      typeof c === 'string' ? c : '',
      typeof co === 'string' ? co : '',
    );
  }

  /**
   * Blocage label: derived from the pause statuses (no separate "blocage"
   * DB column today — the blocked-reason layer was removed in the
   * stagnation pivot). Returns "" when not paused.
   */
  private buildBlocageLabel(status: string): string {
    if (status === 'DIAGNOSTIC_Pause') return 'Diagnostic en pause';
    if (status === 'REPARATION_Pause') return 'Réparation en pause';
    return '';
  }
}

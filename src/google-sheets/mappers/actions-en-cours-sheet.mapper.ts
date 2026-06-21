import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiDocument } from 'src/di/entities/di.entity';
import { firstNonEmpty, formatDateForSheet, safeCell } from '../utils/format.util';
import { IGoogleSheetMapper } from './google-sheet-mapper.interface';

/**
 * "Actions en cours" → live snapshot of every DI currently in the workshop
 * (anything not yet FINISHED, not soft-deleted). Mirrors the columns of the
 * company's existing tracking file:
 *
 *   N° DI | Désignation | N° Série | Client | Date de réception | Rangement | Devis
 *
 * Mode = 'snapshot': the tab is cleared and fully rewritten each run, so it
 * always reflects the present in-shop list and never accumulates duplicates
 * (unlike the daily append log in DiSheetMapper).
 *
 * NOTE: the "Devis" column shows the devis document link the ERP holds
 * (`di.devis`) — the ERP has no separate devis *number* field (e.g. "011/25")
 * yet; add one to populate a real reference here.
 */
@Injectable()
export class ActionsEnCoursSheetMapper implements IGoogleSheetMapper<DiDocument> {
  private readonly logger = new Logger(ActionsEnCoursSheetMapper.name);

  readonly entityName = 'ActionsEnCours';
  readonly mode = 'snapshot' as const;
  readonly range = `${process.env.GOOGLE_SHEETS_ACTIONS_TAB ?? 'Actions en cours'}!A:G`;
  readonly headerRow = [
    'N° DI',
    'Désignation',
    'N° Série',
    'Client',
    'Date de réception',
    'Rangement',
    'Devis',
  ];

  /** Statuses that mean the DI has left the workshop → excluded from the list. */
  private static readonly CLOSED = ['FINISHED'];

  constructor(@InjectModel('Di') private readonly diModel: Model<DiDocument>) {}

  async fetch(): Promise<DiDocument[]> {
    return this.diModel
      .find({
        isDeleted: { $ne: true },
        status: { $nin: ActionsEnCoursSheetMapper.CLOSED },
      })
      .populate('client_id', 'first_name last_name')
      .populate('company_id', 'name')
      .populate('location_id', 'location_name')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  mapToSheetRow(di: DiDocument): string[] {
    try {
      return [
        safeCell(di._idnum), // N° DI
        safeCell(di.title), // Désignation
        safeCell((di as any).nSerie), // N° Série
        this.buildClientName(di), // Client
        formatDateForSheet(di.createdAt), // Date de réception
        this.buildLocation(di), // Rangement
        safeCell((di as any).devis), // Devis (doc link; no devis-number field yet)
      ];
    } catch (err) {
      this.logger.warn(
        `mapToSheetRow failed for DI=${di?._id}: ${(err as Error).message}`,
      );
      return new Array(7).fill('N/A');
    }
  }

  uniqueKey(di: DiDocument): string | null {
    return di?._idnum ?? di?._id ?? null;
  }

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

  private buildLocation(di: DiDocument): string {
    const l: any = (di as any).location_id;
    if (l && typeof l === 'object' && l.location_name) return String(l.location_name);
    return firstNonEmpty(typeof l === 'string' ? l : '', (di as any).location_name);
  }
}

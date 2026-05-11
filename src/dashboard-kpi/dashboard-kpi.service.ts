import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import { ProfileDocument } from 'src/profile/entities/profile.entity';
import { DiDocument } from 'src/di/entities/di.entity';
import { StatDocument } from 'src/stat/entities/stat.entity';
import { STATUS_DI } from 'src/di/di.status';
import {
  CategorySlice,
  FinanceKpi,
  FinanceTrendPoint,
  TrendGranularity,
  TrendPoint,
  VolumeKpi,
} from './entities/dashboard-kpi.entity';

/**
 * Status groupings used everywhere in the dashboard. Centralized here so the
 * service and the frontend stay in lockstep without re-deriving the same set
 * in multiple places.
 *
 * "In progress" mirrors the existing DashboardKpiService convention: every
 * status that is not terminal (FINISHED/ANNULER/RETOUR*) and not pre-flight
 * (CREATED) counts as a DI currently being worked on.
 */
export const FINISHED_STATUSES = [STATUS_DI.Finished.status]; // ['FINISHED']
export const CANCELLED_STATUSES = [STATUS_DI.Annuler.status]; // ['ANNULER']
export const RETOUR_STATUSES = [
  STATUS_DI.Retour1.status,
  STATUS_DI.Retour2.status,
  STATUS_DI.Retour3.status,
];
export const IN_PROGRESS_EXCLUDED = [
  STATUS_DI.Created.status,
  ...FINISHED_STATUSES,
  ...CANCELLED_STATUSES,
  ...RETOUR_STATUSES,
];

/**
 * Parse the front-end's ISO date strings into Date objects. Accepts either a
 * Date passed by GraphQL's scalar Date or a string, both are valid in this
 * codebase.
 */
function parseDate(input: any): Date | null {
  if (!input) return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

function buildDateRangeFilter(
  field: string,
  startDate?: any,
  endDate?: any,
): Record<string, any> {
  const s = parseDate(startDate);
  const e = parseDate(endDate);
  if (!s && !e) return {};
  const range: Record<string, any> = {};
  if (s) range.$gte = s;
  if (e) range.$lte = e;
  return { [field]: range };
}

@Injectable()
export class DashboardKpiService {
  private readonly logger = new Logger(DashboardKpiService.name);

  constructor(
    @InjectModel('Profile') private profileModel: Model<ProfileDocument>,
    @InjectModel('Di') private diModel: Model<DiDocument>,
    @InjectModel('Stat') private statsModel: Model<StatDocument>,
  ) {}

  // ─── SECTION A — KPI ATELIER ────────────────────────────────────────────

  /**
   * % of DIs FINISHED among the total population (date-scoped on createdAt
   * so the metric reflects "DIs created in the period that reached FINISHED").
   */
  private async getTauxDiCloture(startDate?: any, endDate?: any) {
    const dateFilter = buildDateRangeFilter('createdAt', startDate, endDate);
    const baseQuery = { isDeleted: { $ne: true }, ...dateFilter };
    const [totalDi, totalClotures] = await Promise.all([
      this.diModel.countDocuments(baseQuery),
      this.diModel.countDocuments({
        ...baseQuery,
        status: { $in: FINISHED_STATUSES },
      }),
    ]);
    return totalDi ? (totalClotures / totalDi) * 100 : 0;
  }

  /** Snapshot count of DIs currently in-progress (not date-scoped — current state). */
  private async getNbDiEnCours() {
    return this.diModel.countDocuments({
      isDeleted: { $ne: true },
      status: { $nin: IN_PROGRESS_EXCLUDED },
    });
  }

  /** % of the total open backlog made up of in-progress DIs. */
  private async getTauxDiEnCours() {
    const [totalOpen, totalEnCours] = await Promise.all([
      this.diModel.countDocuments({
        isDeleted: { $ne: true },
        status: { $nin: [...FINISHED_STATUSES, ...CANCELLED_STATUSES] },
      }),
      this.getNbDiEnCours(),
    ]);
    return totalOpen ? (totalEnCours / totalOpen) * 100 : 0;
  }

  // ─── SECTION B — DÉLAIS ─────────────────────────────────────────────────

  /**
   * Average end-to-end turn-around time in days for DIs FINISHED in the
   * window. Uses Di.createdAt → Di.updatedAt as the spine — DIs that reach
   * FINISHED have their updatedAt rewritten by the workflow service when the
   * status flips, so this is a reasonable proxy without joining Stat or LogsDi.
   */
  private async getTatMoyenJours(startDate?: any, endDate?: any): Promise<number> {
    const s = parseDate(startDate);
    const e = parseDate(endDate);
    const match: Record<string, any> = {
      isDeleted: { $ne: true },
      status: { $in: FINISHED_STATUSES },
    };
    if (s || e) {
      match.updatedAt = {};
      if (s) match.updatedAt.$gte = s;
      if (e) match.updatedAt.$lte = e;
    }
    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $project: {
          durationMs: { $subtract: ['$updatedAt', '$createdAt'] },
        },
      },
      {
        $group: {
          _id: null,
          avgMs: { $avg: '$durationMs' },
        },
      },
    ];
    const [row] = await this.diModel.aggregate(pipeline);
    const avgMs = row?.avgMs ?? 0;
    return avgMs / (1000 * 60 * 60 * 24);
  }

  /**
   * Share of currently-open DIs that have not moved status for > 72h.
   * Drives the "Taux DI stagnants" gauge.
   */
  private async getTauxStagnant(): Promise<number> {
    const t72 = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const baseOpen = {
      isDeleted: { $ne: true },
      status: { $nin: [...FINISHED_STATUSES, ...CANCELLED_STATUSES] },
    };
    const [totalOpen, stagnant] = await Promise.all([
      this.diModel.countDocuments(baseOpen),
      this.diModel.countDocuments({
        ...baseOpen,
        $or: [
          { statusUpdatedAt: { $lte: t72 } },
          { statusUpdatedAt: null, updatedAt: { $lte: t72 } },
        ],
      }),
    ]);
    return totalOpen ? (stagnant / totalOpen) * 100 : 0;
  }

  /**
   * Average days an OPEN DI has been sitting in its current status. Operational
   * proxy for "how slow is the workflow today?". Reads `statusUpdatedAt` for
   * fresh DIs, falls back to `updatedAt` for legacy ones.
   */
  private async getDelaiMoyenStatutJours(): Promise<number> {
    const now = new Date();
    const pipeline: PipelineStage[] = [
      {
        $match: {
          isDeleted: { $ne: true },
          status: { $nin: [...FINISHED_STATUSES, ...CANCELLED_STATUSES] },
        },
      },
      {
        $project: {
          ageMs: {
            $subtract: [
              now,
              { $ifNull: ['$statusUpdatedAt', '$updatedAt'] },
            ],
          },
        },
      },
      { $group: { _id: null, avgMs: { $avg: '$ageMs' } } },
    ];
    const [row] = await this.diModel.aggregate(pipeline);
    const avgMs = row?.avgMs ?? 0;
    return avgMs / (1000 * 60 * 60 * 24);
  }

  // ─── SECTION C — VOLUME & CHARGE ────────────────────────────────────────

  async getVolumeKpi(startDate?: any, endDate?: any): Promise<VolumeKpi> {
    const s = parseDate(startDate);
    const e = parseDate(endDate);
    const created = buildDateRangeFilter('createdAt', s, e);
    const updated = buildDateRangeFilter('updatedAt', s, e);

    const [nbRecus, nbClotures, nbRetours, nbEnCours] = await Promise.all([
      this.diModel.countDocuments({ isDeleted: { $ne: true }, ...created }),
      this.diModel.countDocuments({
        isDeleted: { $ne: true },
        status: { $in: FINISHED_STATUSES },
        ...updated,
      }),
      this.diModel.countDocuments({
        isDeleted: { $ne: true },
        status: { $in: RETOUR_STATUSES },
        ...updated,
      }),
      // En cours is a snapshot — not date-scoped — to match user expectation
      // of "right now, how many are open?"
      this.getNbDiEnCours(),
    ]);
    return { nbRecus, nbClotures, nbEnCours, nbRetours };
  }

  // ─── SECTION D — WEEKLY/PERIOD TREND ────────────────────────────────────

  /**
   * Build a series of buckets (DAY/WEEK/MONTH) covering [startDate..endDate]
   * with counts of DIs received, closed and returned in each bucket.
   *
   * We run TWO aggregations (received-by-createdAt, closed-or-returned-by-
   * updatedAt) and zip them in memory. Filling missing buckets here means
   * the FE chart gets a continuous timeline without gaps.
   */
  async getTrend(
    startDate: any,
    endDate: any,
    granularity: TrendGranularity = TrendGranularity.WEEK,
  ): Promise<TrendPoint[]> {
    const s = parseDate(startDate) ?? this.defaultStart(granularity);
    const e = parseDate(endDate) ?? new Date();

    const dateTrunc = this.bucketTruncExpr('$createdAt', granularity);
    const dateTruncUpdated = this.bucketTruncExpr('$updatedAt', granularity);

    const [recusRows, finishedRows, retourRows] = await Promise.all([
      this.diModel.aggregate<{ _id: Date; count: number }>([
        {
          $match: {
            isDeleted: { $ne: true },
            createdAt: { $gte: s, $lte: e },
          },
        },
        { $group: { _id: dateTrunc, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      this.diModel.aggregate<{ _id: Date; count: number }>([
        {
          $match: {
            isDeleted: { $ne: true },
            status: { $in: FINISHED_STATUSES },
            updatedAt: { $gte: s, $lte: e },
          },
        },
        { $group: { _id: dateTruncUpdated, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      this.diModel.aggregate<{ _id: Date; count: number }>([
        {
          $match: {
            isDeleted: { $ne: true },
            status: { $in: RETOUR_STATUSES },
            updatedAt: { $gte: s, $lte: e },
          },
        },
        { $group: { _id: dateTruncUpdated, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const buckets = this.enumerateBuckets(s, e, granularity);
    const recusMap = this.indexByBucket(recusRows);
    const finishedMap = this.indexByBucket(finishedRows);
    const retourMap = this.indexByBucket(retourRows);

    return buckets.map((bucketStart) => {
      const key = bucketStart.toISOString();
      return {
        label: this.formatBucketLabel(bucketStart, granularity),
        bucketStart,
        recus: recusMap.get(key) ?? 0,
        clotures: finishedMap.get(key) ?? 0,
        retours: retourMap.get(key) ?? 0,
      };
    });
  }

  // ─── SECTION E — DI PAR CATÉGORIE ───────────────────────────────────────

  async getDiByCategory(startDate?: any, endDate?: any): Promise<CategorySlice[]> {
    const dateFilter = buildDateRangeFilter('createdAt', startDate, endDate);
    const pipeline: PipelineStage[] = [
      { $match: { isDeleted: { $ne: true }, ...dateFilter } },
      {
        $group: {
          _id: '$di_category_id',
          count: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: 'dicategories',
          localField: '_id',
          foreignField: '_id',
          as: 'category',
        },
      },
      {
        $project: {
          categoryId: '$_id',
          categoryName: {
            $ifNull: [{ $arrayElemAt: ['$category.category', 0] }, 'Sans catégorie'],
          },
          count: 1,
        },
      },
      { $sort: { count: -1 } },
    ];
    const rows = await this.diModel.aggregate<CategorySlice>(pipeline);
    return rows.map((r) => ({
      categoryId: r.categoryId ?? null,
      categoryName: r.categoryName ?? 'Sans catégorie',
      count: r.count,
    }));
  }

  // ─── SECTION H — FINANCE (Phase A subset) ───────────────────────────────

  /**
   * Phase A: only the metrics we can derive from the existing Di document
   * are real numbers. Recouvrement, créances, factures>90j, délai paiement,
   * marge brute and coût horaire all require the Phase B Invoice / cost
   * schemas and return null until then so the FE renders an empty-state
   * tile in the same card layout.
   */
  async getFinanceKpi(startDate?: any, endDate?: any): Promise<FinanceKpi> {
    const s = parseDate(startDate);
    const e = parseDate(endDate);
    const updatedRange: Record<string, any> = {};
    if (s) updatedRange.$gte = s;
    if (e) updatedRange.$lte = e;
    const dateFilter = s || e ? { updatedAt: updatedRange } : {};

    const matchFinished = {
      isDeleted: { $ne: true },
      status: { $in: FINISHED_STATUSES },
      ...dateFilter,
    };

    const [totalFinished, billedRows] = await Promise.all([
      this.diModel.countDocuments(matchFinished),
      this.diModel.aggregate<{ caFacture: number; nbBilled: number }>([
        {
          $match: {
            ...matchFinished,
            facture: { $ne: null, $exists: true },
          },
        },
        {
          $group: {
            _id: null,
            caFacture: { $sum: { $ifNull: ['$final_price', 0] } },
            nbBilled: { $sum: 1 },
          },
        },
      ]),
    ]);

    const nbBilled = billedRows[0]?.nbBilled ?? 0;
    const caFacture = billedRows[0]?.caFacture ?? 0;
    const tauxFacturation = totalFinished
      ? (nbBilled / totalFinished) * 100
      : null;

    return {
      tauxFacturation: totalFinished ? tauxFacturation : null,
      caFacture: totalFinished ? caFacture : null,
      // Phase B placeholders — null tells the FE to render the empty-state tile.
      margeBrute: null,
      coutHoraire: null,
      tauxRecouvrement: null,
      creances: null,
      facturesGt90: null,
      delaiPaiementJours: null,
    };
  }

  /**
   * CA & Facturation evolution series. Same bucketing logic as the trend
   * chart, scoped to FINISHED DIs with a facture in the period.
   */
  async getFinanceTrend(
    startDate: any,
    endDate: any,
    granularity: TrendGranularity = TrendGranularity.MONTH,
  ): Promise<FinanceTrendPoint[]> {
    const s = parseDate(startDate) ?? this.defaultStart(granularity);
    const e = parseDate(endDate) ?? new Date();
    const dateTrunc = this.bucketTruncExpr('$updatedAt', granularity);

    const rows = await this.diModel.aggregate<{
      _id: Date;
      caFacture: number;
      nbBilled: number;
      nbFinished: number;
    }>([
      {
        $match: {
          isDeleted: { $ne: true },
          status: { $in: FINISHED_STATUSES },
          updatedAt: { $gte: s, $lte: e },
        },
      },
      {
        $group: {
          _id: dateTrunc,
          caFacture: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$facture', null] }, { $ne: ['$facture', ''] }] },
                { $ifNull: ['$final_price', 0] },
                0,
              ],
            },
          },
          nbBilled: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$facture', null] }, { $ne: ['$facture', ''] }] },
                1,
                0,
              ],
            },
          },
          nbFinished: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const buckets = this.enumerateBuckets(s, e, granularity);
    const map = new Map<string, { caFacture: number; nbBilled: number; nbFinished: number }>();
    for (const r of rows) {
      map.set(r._id.toISOString(), {
        caFacture: r.caFacture,
        nbBilled: r.nbBilled,
        nbFinished: r.nbFinished,
      });
    }
    return buckets.map((bucketStart) => {
      const row = map.get(bucketStart.toISOString());
      return {
        label: this.formatBucketLabel(bucketStart, granularity),
        bucketStart,
        caFacture: row?.caFacture ?? 0,
        tauxFacturation:
          row && row.nbFinished
            ? (row.nbBilled / row.nbFinished) * 100
            : null,
      };
    });
  }

  // ─── COMPOSITE — one fan-out call per dashboard render ──────────────────

  async getDashboardOverview(startDate?: any, endDate?: any) {
    const [
      tauxClotures,
      tauxEnCours,
      nbEnCours,
      tatMoyen,
      tauxStagnant,
      delaiMoyenStatut,
      volume,
      finance,
    ] = await Promise.all([
      this.getTauxDiCloture(startDate, endDate),
      this.getTauxDiEnCours(),
      this.getNbDiEnCours(),
      this.getTatMoyenJours(startDate, endDate),
      this.getTauxStagnant(),
      this.getDelaiMoyenStatutJours(),
      this.getVolumeKpi(startDate, endDate),
      this.getFinanceKpi(startDate, endDate),
    ]);

    return {
      atelier: { tauxClotures, tauxEnCours, nbEnCours },
      delais: {
        tatMoyenJours: tatMoyen,
        tauxStagnant,
        delaiMoyenStatutJours: delaiMoyenStatut,
      },
      satisfaction: { score: null, nbReclamations: null },
      volume,
      finance,
    };
  }

  // ─── Bucket helpers (DAY / WEEK / MONTH) ────────────────────────────────

  private bucketTruncExpr(dateExpr: string, granularity: TrendGranularity) {
    // $dateTrunc is available on Mongo 5.0+. Falls back to manual year/month/
    // day extraction would add complexity for marginal benefit — codebase is
    // already on a recent Mongo per the connection string in app.module.ts.
    const unit =
      granularity === TrendGranularity.DAY
        ? 'day'
        : granularity === TrendGranularity.WEEK
          ? 'week'
          : 'month';
    return {
      $dateTrunc: { date: dateExpr, unit, startOfWeek: 'monday' },
    };
  }

  private enumerateBuckets(start: Date, end: Date, granularity: TrendGranularity): Date[] {
    const out: Date[] = [];
    const cursor = this.truncate(start, granularity);
    const last = this.truncate(end, granularity);
    while (cursor.getTime() <= last.getTime()) {
      out.push(new Date(cursor));
      this.advance(cursor, granularity);
    }
    return out;
  }

  private truncate(date: Date, granularity: TrendGranularity): Date {
    const d = new Date(date);
    if (granularity === TrendGranularity.DAY) {
      d.setUTCHours(0, 0, 0, 0);
    } else if (granularity === TrendGranularity.WEEK) {
      // Match Mongo's startOfWeek:'monday' truncation.
      const day = d.getUTCDay(); // 0=Sun … 6=Sat
      const offset = day === 0 ? 6 : day - 1; // back to Monday
      d.setUTCDate(d.getUTCDate() - offset);
      d.setUTCHours(0, 0, 0, 0);
    } else {
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
    }
    return d;
  }

  private advance(date: Date, granularity: TrendGranularity): void {
    if (granularity === TrendGranularity.DAY) {
      date.setUTCDate(date.getUTCDate() + 1);
    } else if (granularity === TrendGranularity.WEEK) {
      date.setUTCDate(date.getUTCDate() + 7);
    } else {
      date.setUTCMonth(date.getUTCMonth() + 1);
    }
  }

  private formatBucketLabel(d: Date, granularity: TrendGranularity): string {
    if (granularity === TrendGranularity.DAY) {
      return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    if (granularity === TrendGranularity.WEEK) {
      // ISO week number, simple computation
      const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dayNum = (target.getUTCDay() + 6) % 7;
      target.setUTCDate(target.getUTCDate() - dayNum + 3);
      const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
      const week =
        1 +
        Math.round(
          ((target.getTime() - firstThursday.getTime()) / 86_400_000 -
            3 +
            ((firstThursday.getUTCDay() + 6) % 7)) /
            7,
        );
      return `S${String(week).padStart(2, '0')}`;
    }
    const months = [
      'Jan',
      'Fév',
      'Mar',
      'Avr',
      'Mai',
      'Jun',
      'Jul',
      'Aoû',
      'Sep',
      'Oct',
      'Nov',
      'Déc',
    ];
    return `${months[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  }

  private defaultStart(granularity: TrendGranularity): Date {
    const now = new Date();
    const d = new Date(now);
    if (granularity === TrendGranularity.DAY) {
      d.setUTCDate(d.getUTCDate() - 30);
    } else if (granularity === TrendGranularity.WEEK) {
      d.setUTCDate(d.getUTCDate() - 12 * 7);
    } else {
      d.setUTCMonth(d.getUTCMonth() - 12);
    }
    return d;
  }

  private indexByBucket(
    rows: Array<{ _id: Date; count: number }>,
  ): Map<string, number> {
    const m = new Map<string, number>();
    for (const r of rows) {
      m.set(new Date(r._id).toISOString(), r.count);
    }
    return m;
  }
}

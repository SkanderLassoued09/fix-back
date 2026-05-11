import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import { DiDocument } from 'src/di/entities/di.entity';
import { ProfileDocument } from 'src/profile/entities/profile.entity';
import { StatDocument } from 'src/stat/entities/stat.entity';
import { STATUS_DI } from 'src/di/di.status';
import { TechLeaderRow } from './entities/dashboard-kpi.entity';
import {
  FINISHED_STATUSES,
  RETOUR_STATUSES,
} from './dashboard-kpi.service';

/**
 * Tech leaderboard analytics. Lives alongside DashboardKpiService but kept
 * separate because per-tech aggregation has different join shape (Stat →
 * Di → Profile) than the global KPIs and would bloat the main service.
 *
 * FTR (First Time Right) definition (locked in by the user):
 *   A FINISHED DI counts as FTR when ignoreCount === 0 — i.e. it never had
 *   to be reopened through a RETOUR cycle.
 */
@Injectable()
export class TechAnalyticsService {
  private readonly logger = new Logger(TechAnalyticsService.name);

  constructor(
    @InjectModel('Stat') private readonly statModel: Model<StatDocument>,
    @InjectModel('Di') private readonly diModel: Model<DiDocument>,
    @InjectModel('Profile') private readonly profileModel: Model<ProfileDocument>,
  ) {}

  /**
   * Aggregate per-technician performance over a date window. Pulls Stats
   * scoped by createdAt (when the assignment happened), joins each Stat to
   * the live Di document so we always read the freshest status / retour /
   * irreparable flag, dedupes by (tech, di) so a DI with both diag and rep
   * stages by the same tech counts once.
   */
  async getTechLeaderboard(
    startDate?: any,
    endDate?: any,
    limit = 20,
  ): Promise<TechLeaderRow[]> {
    const s = startDate ? new Date(startDate) : null;
    const e = endDate ? new Date(endDate) : null;
    const dateMatch: Record<string, any> = {};
    if (s || e) {
      dateMatch.createdAt = {};
      if (s) dateMatch.createdAt.$gte = s;
      if (e) dateMatch.createdAt.$lte = e;
    }

    const pipeline: PipelineStage[] = [
      { $match: dateMatch },
      // Emit one row per (tech, di). A stat can list a diag tech, a rep tech,
      // or both — duplicate the row and let the downstream group dedupe by
      // (techId, diId) so the same DI counted twice for the same tech doesn't
      // inflate the leaderboard.
      {
        $project: {
          _idDi: 1,
          ignoreCount: 1,
          techs: {
            $filter: {
              input: ['$id_tech_diag', '$id_tech_rep'],
              as: 't',
              cond: { $and: [{ $ne: ['$$t', null] }, { $ne: ['$$t', ''] }] },
            },
          },
        },
      },
      { $unwind: '$techs' },
      // Dedupe (tech, di) pairs.
      {
        $group: {
          _id: { tech: '$techs', di: '$_idDi' },
          ignoreCount: { $first: '$ignoreCount' },
        },
      },
      // Join the live DI document for current status / can_be_repaired /
      // created→finished delta.
      {
        $lookup: {
          from: 'dis',
          localField: '_id.di',
          foreignField: '_id',
          as: 'di',
        },
      },
      { $unwind: { path: '$di', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          techId: '$_id.tech',
          diId: '$_id.di',
          status: '$di.status',
          canBeRepaired: '$di.can_be_repaired',
          createdAt: '$di.createdAt',
          updatedAt: '$di.updatedAt',
          ignoreCount: '$di.ignoreCount',
        },
      },
      // Aggregate per technician.
      {
        $group: {
          _id: '$techId',
          nbDiTraites: { $sum: 1 },
          nbDiClotures: {
            $sum: {
              $cond: [{ $in: ['$status', FINISHED_STATUSES] }, 1, 0],
            },
          },
          nbFinishedFtr: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ['$status', FINISHED_STATUSES] },
                    {
                      $or: [
                        { $eq: ['$ignoreCount', 0] },
                        { $not: ['$ignoreCount'] },
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
          nbRetours: {
            $sum: {
              $cond: [{ $in: ['$status', RETOUR_STATUSES] }, 1, 0],
            },
          },
          nbIrreparables: {
            $sum: { $cond: [{ $eq: ['$canBeRepaired', false] }, 1, 0] },
          },
          totalTatMs: {
            $sum: {
              $cond: [
                { $in: ['$status', FINISHED_STATUSES] },
                { $subtract: ['$updatedAt', '$createdAt'] },
                0,
              ],
            },
          },
        },
      },
      // Join the technician profile for the display name.
      {
        $lookup: {
          from: 'profiles',
          localField: '_id',
          foreignField: '_id',
          as: 'profile',
        },
      },
      {
        $project: {
          techId: '$_id',
          profile: { $arrayElemAt: ['$profile', 0] },
          nbDiTraites: 1,
          nbDiClotures: 1,
          nbFinishedFtr: 1,
          nbRetours: 1,
          nbIrreparables: 1,
          totalTatMs: 1,
        },
      },
      { $sort: { nbDiTraites: -1 } },
      { $limit: Math.min(limit, 100) },
    ];

    const rows = await this.statModel.aggregate<{
      techId: string;
      profile?: { firstName?: string; lastName?: string; role?: string };
      nbDiTraites: number;
      nbDiClotures: number;
      nbFinishedFtr: number;
      nbRetours: number;
      nbIrreparables: number;
      totalTatMs: number;
    }>(pipeline);

    return rows.map<TechLeaderRow>((r) => {
      const firstTimeRight = r.nbDiClotures
        ? (r.nbFinishedFtr / r.nbDiClotures) * 100
        : 0;
      const tauxRetours = r.nbDiTraites
        ? (r.nbRetours / r.nbDiTraites) * 100
        : 0;
      const tauxIrreparables = r.nbDiTraites
        ? (r.nbIrreparables / r.nbDiTraites) * 100
        : 0;
      const tatMoyenJours = r.nbDiClotures
        ? r.totalTatMs / r.nbDiClotures / (1000 * 60 * 60 * 24)
        : 0;

      const first = r.profile?.firstName ?? '';
      const last = r.profile?.lastName ?? '';
      const techName =
        [first, last].filter(Boolean).join(' ').trim() || r.techId;

      return {
        techId: r.techId,
        techName,
        role: r.profile?.role ?? null,
        nbDiTraites: r.nbDiTraites,
        nbDiClotures: r.nbDiClotures,
        firstTimeRight,
        tauxRetours,
        tatMoyenJours,
        tauxIrreparables,
      };
    });
  }
}

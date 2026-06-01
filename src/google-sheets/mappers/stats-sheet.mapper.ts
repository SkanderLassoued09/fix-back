import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiDocument } from 'src/di/entities/di.entity';
import { StatDocument } from 'src/stat/entities/stat.entity';
import { formatDateForSheet } from '../utils/format.util';
import { IGoogleSheetMapper } from './google-sheet-mapper.interface';

/**
 * Daily aggregated KPI row written to a separate tab. Demonstrates the
 * multi-entity pattern: a second concrete mapper with its own range, its
 * own header shape, and its own fetch() — no shared business logic with
 * DiSheetMapper. Adding a third entity later means dropping in another
 * file like this and registering it in GoogleSheetsModule.
 *
 * Target tab header (must match the spreadsheet's row 1 on the Stats tab):
 *   Date | DI créés | DI clôturés | DI en cours | DI en pause | Stats total
 *
 * Returns a single row per run (today's snapshot). Uses real Mongo counts
 * — no fabricated KPIs.
 */
@Injectable()
export class StatsSheetMapper
  implements IGoogleSheetMapper<StatsSheetMapper.AggregateRow>
{
  private readonly logger = new Logger(StatsSheetMapper.name);

  readonly entityName = 'Stats';
  readonly range = `${process.env.GOOGLE_SHEETS_STATS_TAB ?? 'Stats'}!A:F`;
  readonly headerRow = [
    'Date',
    'DI créés',
    'DI clôturés',
    'DI en cours',
    'DI en pause',
    'Stats total',
  ];

  constructor(
    @InjectModel('Di') private readonly diModel: Model<DiDocument>,
    @InjectModel('Stat') private readonly statModel: Model<StatDocument>,
  ) {}

  async fetch(): Promise<StatsSheetMapper.AggregateRow[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const base = { isDeleted: { $ne: true } };

    const [createdToday, finishedToday, inProgress, paused, statsTotal] =
      await Promise.all([
        this.diModel.countDocuments({ ...base, createdAt: { $gte: since } }),
        this.diModel.countDocuments({
          ...base,
          status: 'FINISHED',
          updatedAt: { $gte: since },
        }),
        this.diModel.countDocuments({
          ...base,
          status: {
            $nin: ['CREATED', 'FINISHED', 'ANNULER', 'RETOUR1', 'RETOUR2', 'RETOUR3'],
          },
        }),
        this.diModel.countDocuments({
          ...base,
          status: { $in: ['DIAGNOSTIC_Pause', 'REPARATION_Pause'] },
        }),
        this.statModel.estimatedDocumentCount(),
      ]);

    return [
      {
        date: new Date(),
        createdToday,
        finishedToday,
        inProgress,
        paused,
        statsTotal,
      },
    ];
  }

  mapToSheetRow(r: StatsSheetMapper.AggregateRow): (string | number)[] {
    try {
      return [
        formatDateForSheet(r.date),
        r.createdToday,
        r.finishedToday,
        r.inProgress,
        r.paused,
        r.statsTotal,
      ];
    } catch (err) {
      this.logger.warn(
        `mapToSheetRow failed for stats aggregate: ${(err as Error).message}`,
      );
      return new Array(6).fill('N/A');
    }
  }

  uniqueKey(r: StatsSheetMapper.AggregateRow): string {
    // One snapshot per calendar day — natural dedupe target.
    const d = r.date;
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
}

// Local row shape — kept inside the mapper namespace so it doesn't leak
// out as a public surface other modules can depend on.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace StatsSheetMapper {
  export interface AggregateRow {
    date: Date;
    createdToday: number;
    finishedToday: number;
    inProgress: number;
    paused: number;
    statsTotal: number;
  }
}

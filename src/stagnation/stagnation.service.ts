import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AlertSeverity, AlertType } from 'src/alerts/alert.enums';
import { DiAlertService } from 'src/alerts/alerts.service';
import { DiDocument } from 'src/di/entities/di.entity';
import { STATUS_DI } from 'src/di/di.status';

/** One bucket of the daily stagnation digest (grouped Discord reminder). */
export interface StagnationDigestBucket {
  type: AlertType;
  label: string;
  severity: AlertSeverity;
  count: number;
  /** Up to a few example DI refs (`_idnum`) shown in the embed. */
  examples: string[];
}

/** How many example DI refs to surface per bucket in the digest embed. */
const DIGEST_EXAMPLE_COUNT = 8;

/**
 * Generic stagnation monitor. Detects DIs that have remained in the same
 * workflow status for longer than a set of thresholds (24h / 72h / 7d) and
 * raises persistent operational alerts.
 *
 * The service is the single business-logic unit:
 *   - Cron triggers it (no logic in the cron itself).
 *   - The ACTION runtime entry point (`ACTION=DETECT_STAGNANT_DI`) calls
 *     the exact same method.
 *   - A future HTTP/GraphQL "run now" button can call it too.
 *
 * Logger lifecycle is INSIDE the method (per architecture guideline: no
 * wrapper helper methods that own logging).
 */
@Injectable()
export class StagnationService {
  private readonly logger = new Logger(StagnationService.name);

  /** Statuses that are terminal — never flagged as "stagnant". */
  private static readonly TERMINAL_STATUSES = [
    STATUS_DI.Finished.status,
    STATUS_DI.Annuler.status,
  ];

  /**
   * Mutually-exclusive thresholds, processed highest-severity first so a DI
   * untouched for 8 days raises one DI_STAGNANT_7D — not all three.
   *
   * Adding a new threshold is a single entry here; no other code change.
   */
  private static readonly THRESHOLDS = [
    {
      type: AlertType.DI_STAGNANT_7D,
      severity: AlertSeverity.CRITICAL,
      lowerMs: 7 * 24 * 60 * 60 * 1000, // ≥ 7 days
      upperMs: Infinity,
      label: '7 days',
      digestLabel: '> 7 jours',
      resolveOnEscalation: [AlertType.DI_STAGNANT_72H, AlertType.DI_STAGNANT_24H],
    },
    {
      type: AlertType.DI_STAGNANT_72H,
      severity: AlertSeverity.WARNING,
      lowerMs: 72 * 60 * 60 * 1000, // ≥ 72h, < 7d
      upperMs: 7 * 24 * 60 * 60 * 1000,
      label: '72 hours',
      digestLabel: '72 h – 7 j',
      resolveOnEscalation: [AlertType.DI_STAGNANT_24H],
    },
    {
      type: AlertType.DI_STAGNANT_24H,
      severity: AlertSeverity.INFO,
      lowerMs: 24 * 60 * 60 * 1000, // ≥ 24h, < 72h
      upperMs: 72 * 60 * 60 * 1000,
      label: '24 hours',
      digestLabel: '24 h – 72 h',
      resolveOnEscalation: [],
    },
  ];

  constructor(
    @InjectModel('Di') private readonly diModel: Model<DiDocument>,
    private readonly alertService: DiAlertService,
  ) {}

  /**
   * Detect stagnant DIs and emit alerts. Idempotent — re-running does not
   * fan out duplicate alerts (the alert service dedupes by {diId, type, open}).
   * Returns a summary so callers (cron, ACTION runtime) can log results.
   */
  async detectStagnantDi(): Promise<{
    scanned: number;
    created: Record<string, number>;
    resolvedFromEscalation: number;
    elapsedMs: number;
    buckets: StagnationDigestBucket[];
  }> {
    this.logger.log('START detectStagnantDi');
    const startedAt = Date.now();

    const now = new Date();
    const created: Record<string, number> = {
      DI_STAGNANT_24H: 0,
      DI_STAGNANT_72H: 0,
      DI_STAGNANT_7D: 0,
    };
    // Per-bucket snapshot for the daily grouped Discord digest — the CURRENT
    // count of stagnant DIs in each band (not just newly-created alerts).
    const digestByType: Record<string, StagnationDigestBucket> = {};
    let scanned = 0;
    let resolvedFromEscalation = 0;

    for (const bucket of StagnationService.THRESHOLDS) {
      const upperBound = new Date(now.getTime() - bucket.lowerMs);
      const lowerBound =
        bucket.upperMs === Infinity
          ? null
          : new Date(now.getTime() - bucket.upperMs);

      // Build the query: DI is open, last status change is OLD enough for
      // this bucket but not so old it belongs in a higher bucket.
      // Use $ifNull-style fallback to `updatedAt` for legacy DIs that
      // existed before `statusUpdatedAt` was introduced.
      const baseMatch: any = {
        isDeleted: { $ne: true },
        status: { $nin: StagnationService.TERMINAL_STATUSES },
      };

      const ageCondition: any = { $lte: upperBound };
      if (lowerBound) {
        ageCondition.$gt = lowerBound;
      }

      const stagnant = await this.diModel
        .find({
          ...baseMatch,
          $or: [
            { statusUpdatedAt: ageCondition },
            // Backfill path: no statusUpdatedAt → use updatedAt as a proxy.
            {
              statusUpdatedAt: null,
              updatedAt: ageCondition,
            },
          ],
        })
        .select('_id _idnum status statusUpdatedAt updatedAt')
        .lean();

      this.logger.log(
        `[${bucket.label}] matched ${stagnant.length} DI(s) in ${bucket.type} band`,
      );
      scanned += stagnant.length;

      // Snapshot this band for the grouped daily digest (count + a few refs).
      digestByType[bucket.type] = {
        type: bucket.type,
        label: bucket.digestLabel,
        severity: bucket.severity,
        count: stagnant.length,
        examples: stagnant
          .slice(0, DIGEST_EXAMPLE_COUNT)
          .map((di: any) => di._idnum ?? di._id),
      };

      for (const di of stagnant) {
        const stagnationStarted = di.statusUpdatedAt ?? di.updatedAt;
        const ageMs = now.getTime() - new Date(stagnationStarted).getTime();
        const ageHours = Math.round(ageMs / (60 * 60 * 1000));

        const result = await this.alertService.createAlertIfMissing(
          {
            diId: di._id,
            type: bucket.type,
            severity: bucket.severity,
            message: `DI ${di._idnum ?? di._id} stagnant in ${di.status} for ${ageHours}h (threshold: ${bucket.label}).`,
            assignedRoles: ['Manager', 'Admin_Manager', 'Coordinator'],
            metadataJson: JSON.stringify({
              diIdnum: di._idnum ?? null,
              status: di.status,
              stagnationStartedAt: stagnationStarted,
              ageMs,
              threshold: bucket.type,
            }),
          },
          // Digest-only: no per-DI Discord ping. The daily 08:00 cron sends ONE
          // grouped embed instead. Alerts are still persisted + escalated.
          { silent: true },
        );

        if (result.created) {
          created[bucket.type]++;
        }

        // Escalation: close any lower-tier open alerts for this DI now that
        // we've raised a higher one. Keeps the alert inbox clean.
        if (bucket.resolveOnEscalation.length) {
          const closedCount = await this.alertService.resolveOpenAlertsForDi(
            di._id,
            bucket.resolveOnEscalation,
            null,
          );
          resolvedFromEscalation += closedCount;
        }
      }
    }

    const elapsedMs = Date.now() - startedAt;
    this.logger.log(
      `END detectStagnantDi · scanned=${scanned} ` +
        `created={24h:${created.DI_STAGNANT_24H}, 72h:${created.DI_STAGNANT_72H}, 7d:${created.DI_STAGNANT_7D}} ` +
        `escalated=${resolvedFromEscalation} elapsedMs=${elapsedMs}`,
    );

    // Ascending severity order for the digest embed: 24h → 72h → >7j.
    const buckets = [
      AlertType.DI_STAGNANT_24H,
      AlertType.DI_STAGNANT_72H,
      AlertType.DI_STAGNANT_7D,
    ]
      .map((type) => digestByType[type])
      .filter(Boolean);

    return { scanned, created, resolvedFromEscalation, elapsedMs, buckets };
  }

  /**
   * Read-side: list currently-stagnant DIs grouped by threshold. Useful for
   * dashboards and the future "stuck DI" admin view.
   */
  async listStagnantDi(limit = 200) {
    const now = new Date();
    const t24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return this.diModel
      .find({
        isDeleted: { $ne: true },
        status: { $nin: StagnationService.TERMINAL_STATUSES },
        $or: [
          { statusUpdatedAt: { $lte: t24 } },
          { statusUpdatedAt: null, updatedAt: { $lte: t24 } },
        ],
      })
      .sort({ statusUpdatedAt: 1, updatedAt: 1 })
      .limit(Math.min(limit, 500))
      .lean();
  }
}

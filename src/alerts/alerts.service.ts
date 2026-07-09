import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { nanoid } from 'nanoid';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { AlertSeverity, AlertType } from './alert.enums';
import { CreateAlertInput, ListAlertsInput } from './dto/alert.input';
import { DiAlertDocument } from './entities/di-alert.entity';

/**
 * Centralized alert service. The rest of the system creates alerts through
 * here so persistence, deduping, and the Discord side-effect all live in
 * one place. Generators (stagnation today, future operational monitors
 * tomorrow) inject this service and never touch the model directly.
 *
 * Today the only external broadcast is Discord. WebSocket emit was removed
 * so the alert system runs identically in NORMAL and ACTION modes (no
 * Socket.IO server is bound in createApplicationContext).
 */
@Injectable()
export class DiAlertService {
  private readonly logger = new Logger(DiAlertService.name);

  constructor(
    @InjectModel('DiAlert')
    private readonly alertModel: Model<DiAlertDocument>,
    private readonly discordHookService: DiscordHookService,
  ) {}

  async createAlert(
    input: CreateAlertInput,
    opts?: { silent?: boolean },
  ): Promise<DiAlertDocument> {
    let metadata: Record<string, any> = {};
    if (input.metadataJson) {
      try {
        metadata = JSON.parse(input.metadataJson);
      } catch (err) {
        this.logger.warn(
          `Ignoring invalid metadataJson for alert on di=${input.diId}: ${err}`,
        );
      }
    }

    const doc = await this.alertModel.create({
      // _id: `ALR_${nanoid(8)}`,
      diId: input.diId,
      type: input.type,
      severity: input.severity ?? AlertSeverity.INFO,
      message: input.message,
      assignedRoles: input.assignedRoles ?? [],
      metadata,
      escalationLevel: input.escalationLevel ?? 0,
    });

    this.logger.log(
      `Alert created · _id=${doc._id} diId=${doc.diId} type=${doc.type} severity=${doc.severity}`,
    );

    // Discord broadcast — best-effort. A failed webhook NEVER fails the alert
    // (persistence is the source of truth) and never breaks the caller flow.
    // `silent` skips the per-alert embed: the stagnation monitor now sends ONE
    // grouped DAILY digest instead of one embed per DI. Future alert generators
    // can still get a per-alert ping by omitting the flag.
    if (!opts?.silent) {
      try {
        await this.discordHookService.sendStagnationAlert({
          _id: doc._id as string,
          diId: doc.diId,
          type: doc.type,
          severity: doc.severity,
          message: doc.message,
          metadata: doc.metadata,
          createdAt: doc.createdAt,
        });
        this.logger.log(`Discord notification sent · _id=${doc._id}`);
      } catch (err) {
        this.logger.error(
          `Discord notification failed · _id=${doc._id}: ${
            (err as Error).message ?? err
          }`,
        );
      }
    }

    return doc;
  }

  /**
   * Idempotent helper: only creates an alert if no open alert of the same
   * type already exists for this DI. Used by the stagnation detector so
   * re-running the evaluator every hour does not generate duplicate alerts
   * (and does not re-send Discord notifications).
   */
  async createAlertIfMissing(
    input: CreateAlertInput,
    opts?: { silent?: boolean },
  ): Promise<{ alert: DiAlertDocument; created: boolean }> {
    const existing = await this.alertModel.findOne({
      diId: input.diId,
      type: input.type,
      resolvedAt: null,
    });
    if (existing) {
      this.logger.log(
        `Alert skipped (already exists) · diId=${input.diId} type=${input.type}`,
      );
      return { alert: existing, created: false };
    }
    const created = await this.createAlert(input, opts);
    return { alert: created, created: true };
  }

  async resolveAlert(
    alertId: string,
    resolvedBy: string | null,
  ): Promise<DiAlertDocument | null> {
    return this.alertModel.findByIdAndUpdate(
      alertId,
      { $set: { resolvedAt: new Date(), resolvedBy } },
      { new: true },
    );
  }

  /**
   * Resolve every open alert of the given types for a DI. Used by the
   * stagnation escalation flow so a DI that crosses into a higher tier
   * doesn't keep showing stale lower-tier alerts.
   */
  async resolveOpenAlertsForDi(
    diId: string,
    types: AlertType[],
    resolvedBy: string | null,
  ): Promise<number> {
    const result = await this.alertModel.updateMany(
      { diId, type: { $in: types }, resolvedAt: null },
      { $set: { resolvedAt: new Date(), resolvedBy } },
    );
    return result.modifiedCount ?? 0;
  }

  async listAlerts(input: ListAlertsInput = {}): Promise<DiAlertDocument[]> {
    const filter: FilterQuery<DiAlertDocument> = {};
    if (input.diId) filter.diId = input.diId;
    if (input.type) filter.type = input.type;
    if (input.role) filter.assignedRoles = input.role;
    if (input.openOnly !== false) filter.resolvedAt = null;

    return this.alertModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(input.limit ?? 200, 500))
      .exec();
  }
}

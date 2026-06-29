import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JiraSearchIssue, JiraService } from 'src/jira/jira.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { JiraCronNotificationDocument } from './entities/jira-cron-notification.entity';

export interface SyncResult {
  /** Issues returned by Jira for the due-soon window. */
  fetched: number;
  /** Newly inserted PENDING rows (existing rows are left untouched). */
  inserted: number;
  /** Set when the run was a no-op because Jira isn't configured. */
  skipped?: boolean;
  /** Set when the Jira API call failed (run aborted cleanly, 0 inserted). */
  error?: string;
}

/** Result of the notify cron (SYNC_JIRA_DUE_SOON). */
export interface NotifyResult {
  /** Rows atomically claimed (PENDING → PROCESSING) by this run. */
  claimed: number;
  /** Claimed rows successfully notified → PROCESSED. */
  processed: number;
  /** Claimed rows that failed delivery → reverted PENDING (or FAILED). */
  failed: number;
  /** Set when the run was a no-op because Discord isn't configured. */
  skipped?: boolean;
  /** Set when delivery failed (the global error message). */
  error?: string;
}

/**
 * The `jira_cron_notifications` pipeline, split across TWO standalone crons:
 *
 *   - Cron 1 — SYNC_JIRA_TASKS → `syncTaches()`: reads Jira (OPEN tasks due
 *     ≤ 24h) and UPSERTS them as PENDING rows, keyed by a DAILY dedupeKey
 *     `{issueKey}:{YYYY-MM-DD}` (Africa/Tunis). Daily dedup: same day = no-op
 *     (never resurrects a PROCESSED/FAILED row); next day = new key = re-nudge.
 *
 *   - Cron 2 — SYNC_JIRA_DUE_SOON → `envoyerNotifications()`: NO Jira call. The
 *     collection is the source of truth — it atomically CLAIMS the PENDING rows,
 *     sends ONE grouped Discord digest, and marks them PROCESSED.
 *
 * Pure business logic — no bootstrap / process.exit — so it is unit-testable in
 * isolation (the runner is the ACTION dispatcher in AppCronService).
 */
@Injectable()
export class JiraCronNotificationService {
  private readonly logger = new Logger(JiraCronNotificationService.name);

  constructor(
    @InjectModel('JiraCronNotification')
    private readonly model: Model<JiraCronNotificationDocument>,
    private readonly jiraService: JiraService,
    private readonly discordHook: DiscordHookService,
  ) {}

  /** `YYYY-MM-DD` for "today" in Africa/Tunis. `en-CA` formats ISO order; no tz
   *  library needed. Isolated as a method so tests can pin it. */
  private todayTunis(): string {
    return new Date().toLocaleDateString('en-CA', {
      timeZone: 'Africa/Tunis',
    });
  }

  /**
   * JQL for SYNC_JIRA_TASKS — OPEN tasks (statusCategory "To Do"/"In Progress",
   * robust to custom status names) whose due date is within the window.
   */
  private buildTasksJql(): string {
    const project = (process.env.JIRA_PROJECT_KEY ?? '').trim();
    const windowExpr = (process.env.JIRA_DUE_WINDOW ?? '1d').trim();
    // Label filter is OPT-IN (default: none). Set JIRA_DUE_LABEL to scope.
    const label = (process.env.JIRA_DUE_LABEL ?? '').trim();
    const clauses = [
      'statusCategory in ("To Do", "In Progress")',
      project ? `project = "${project}"` : '',
      'duedate >= now()',
      `duedate <= ${windowExpr}`,
      label ? `labels = "${label}"` : '',
    ].filter(Boolean);
    return `${clauses.join(' AND ')} ORDER BY duedate ASC`;
  }

  /**
   * Upsert each issue as a PENDING row keyed `{issueKey}:{day}`. `$setOnInsert`
   * ONLY ⇒ inserts when absent, no-op when the day's row already exists (never
   * resurrects PROCESSED/FAILED, no intra-day duplicate). Returns # inserted.
   */
  private async upsertIssuesAsPending(
    issues: JiraSearchIssue[],
    day: string,
  ): Promise<number> {
    let inserted = 0;
    for (const issue of issues) {
      if (!issue?.issueKey) continue;
      const dedupeKey = `${issue.issueKey}:${day}`;
      try {
        const res: any = await this.model.updateOne(
          { dedupeKey },
          {
            $setOnInsert: {
              status: 'PENDING',
              source: 'JIRA',
              dedupeKey,
              issueKey: issue.issueKey,
              titre: issue.titre,
              responsable: issue.responsable ?? null,
              echeance: issue.echeance ?? null,
              url: issue.url,
              attempts: 0,
            },
          },
          { upsert: true },
        );
        if ((res?.upsertedCount ?? 0) > 0 || res?.upsertedId) inserted++;
      } catch (e: any) {
        // 11000 = unique-index race on a concurrent run → the row exists, fine.
        if (e?.code !== 11000) {
          this.logger.error(`Upsert ${dedupeKey} échoué: ${e?.message ?? e}`);
        }
      }
    }
    return inserted;
  }

  /**
   * Shared run: configured-gate → JQL search → daily upsert. Never throws — a
   * Jira outage → `{ inserted: 0, error }`; no issues → no-op; unconfigured →
   * `{ skipped: true }`.
   */
  private async run(jql: string, label: string): Promise<SyncResult> {
    if (!this.jiraService.isConfigured) {
      this.logger.warn(
        'Jira non configuré (JIRA_*) — synchronisation ignorée.',
      );
      return { fetched: 0, inserted: 0, skipped: true };
    }

    let issues: JiraSearchIssue[];
    try {
      issues = await this.jiraService.searchIssues(jql);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      this.logger.error(`Recherche Jira échouée (${jql}): ${message}`);
      return { fetched: 0, inserted: 0, error: message };
    }

    if (!issues.length) {
      this.logger.log(`${label}: aucune issue — rien à insérer.`);
      return { fetched: 0, inserted: 0 };
    }

    const inserted = await this.upsertIssuesAsPending(
      issues,
      this.todayTunis(),
    );
    this.logger.log(
      `${label}: ${issues.length} issue(s) vue(s), ${inserted} nouvelle(s) PENDING.`,
    );
    return { fetched: issues.length, inserted };
  }

  /** SYNC_JIRA_TASKS — OPEN (TODO/IN-PROGRESS) tasks due within ~24h. */
  async syncTaches(): Promise<SyncResult> {
    return await this.run(
      this.buildTasksJql(),
      'Jira tasks (TODO/IN-PROGRESS)',
    );
  }

  /**
   * SYNC_JIRA_DUE_SOON (Cron 2) — DB-driven, NO Jira call. Reads the PENDING
   * rows that Cron 1 produced, atomically claims them, sends ONE grouped Discord
   * digest, and marks them PROCESSED. Concurrency-safe + idempotent:
   *
   *   1. Skip cleanly if no PV/Jira-digest webhook is configured.
   *   2. Per row: `findOneAndUpdate({ _id, status:'PENDING' }, status:'PROCESSING')`
   *      — an atomic claim. A row already claimed by a parallel run returns null
   *      ⇒ skipped, so a row is notified exactly once even multi-instance.
   *   3. Send a single grouped embed (sectioned by responsable).
   *   4. Success → claimed rows go PROCESSED. Failure → revert to PENDING with
   *      `attempts++` and `lastError` (retried next run); a row that reached
   *      JIRA_NOTIF_MAX_ATTEMPTS goes FAILED instead, to stop looping forever.
   */
  async envoyerNotifications(): Promise<NotifyResult> {
    if (!this.discordHook.isPvConfigured) {
      this.logger.warn(
        'Discord (DISCORD_PV_WEBHOOK_URL) non configuré — envoi ignoré.',
      );
      return { claimed: 0, processed: 0, failed: 0, skipped: true };
    }

    const pendings: any[] = await this.model.find({ status: 'PENDING' }).lean();
    if (!pendings.length) {
      this.logger.log('Aucune notification PENDING — rien à envoyer.');
      return { claimed: 0, processed: 0, failed: 0 };
    }

    // Atomic claim, one row at a time (PENDING → PROCESSING).
    const claimed: any[] = [];
    for (const p of pendings) {
      const row: any = await this.model.findOneAndUpdate(
        { _id: p._id, status: 'PENDING' },
        { $set: { status: 'PROCESSING' } },
        { new: true },
      );
      if (row) claimed.push(row.toObject ? row.toObject() : row);
    }
    if (!claimed.length) {
      this.logger.log('Tous les PENDING déjà claimés par une autre exécution.');
      return { claimed: 0, processed: 0, failed: 0 };
    }

    const ids = claimed.map((c) => c._id);
    try {
      await this.discordHook.sendJiraTasksDigest(claimed);
      await this.model.updateMany(
        { _id: { $in: ids } },
        { $set: { status: 'PROCESSED' } },
      );
      this.logger.log(
        `Jira notif: ${claimed.length} tâche(s) notifiée(s) → PROCESSED.`,
      );
      return { claimed: claimed.length, processed: claimed.length, failed: 0 };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      const max = Number(process.env.JIRA_NOTIF_MAX_ATTEMPTS ?? 5) || 5;
      const toFail = claimed
        .filter((c) => (c.attempts ?? 0) + 1 >= max)
        .map((c) => c._id);
      const toRetry = claimed
        .filter((c) => (c.attempts ?? 0) + 1 < max)
        .map((c) => c._id);
      if (toRetry.length) {
        await this.model.updateMany(
          { _id: { $in: toRetry } },
          {
            $set: { status: 'PENDING', lastError: message },
            $inc: { attempts: 1 },
          },
        );
      }
      if (toFail.length) {
        await this.model.updateMany(
          { _id: { $in: toFail } },
          {
            $set: { status: 'FAILED', lastError: message },
            $inc: { attempts: 1 },
          },
        );
      }
      this.logger.error(
        `Envoi Discord échoué: ${message} — ${claimed.length} revert PENDING (${toFail.length} → FAILED).`,
      );
      return {
        claimed: claimed.length,
        processed: 0,
        failed: claimed.length,
        error: message,
      };
    }
  }
}

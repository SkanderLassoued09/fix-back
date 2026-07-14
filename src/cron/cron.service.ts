import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PubSub } from 'graphql-subscriptions';
import { AuditService } from 'src/audit/audit.service';
import { DiService } from 'src/di/di.service';
import { Di } from 'src/di/entities/di.entity';
import { NotificationsGateway } from 'src/notification.gateway';
import { StagnationService } from 'src/stagnation/stagnation.service';
import { SheetSyncService } from 'src/google-sheets/sheet-sync.service';
import { JiraCronNotificationService } from 'src/jira-cron-notification/jira-cron-notification.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { DiArchiveDigestService } from 'src/di-archive/di-archive-digest.service';
import { ReunionPVService } from 'src/reunion-pv/reunion-pv.service';

/**
 * The 5 Discord channels of an environment, mapped to the EXACT env vars read
 * from `.env.<env>`. Add a channel = one entry here.
 */
const DISCORD_TEST_CHANNELS: Array<{ name: string; envVar: string }> = [
  { name: 'general-atelier', envVar: 'DISCORD_GENERAL_ATELIER_WEBHOOK' },
  { name: 'demande-pdf', envVar: 'DISCORD_DEMANDE_PDF_WEBHOOK' },
  { name: 'service-technique', envVar: 'DISCORD_SERVICE_TECHNIQUE_WEBHOOK' },
  { name: 'error', envVar: 'DISCORD_ERROR_WEBHOOK' },
  { name: 'app-alert', envVar: 'DISCORD_APP_ALERT_WEBHOOK' },
];

@Injectable()
export class AppCronService {
  private readonly logger = new Logger(AppCronService.name);
  pubSub = new PubSub();
  constructor(
    private readonly diService: DiService,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly auditService: AuditService,
    private readonly stagnationService: StagnationService,
    private readonly sheetSyncService: SheetSyncService,
    private readonly jiraCronNotificationService: JiraCronNotificationService,
    private readonly discordHookService: DiscordHookService,
    private readonly diArchiveDigestService: DiArchiveDigestService,
    private readonly reunionPVService: ReunionPVService,
  ) {}

  /**
   * Central ACTION dispatcher. main.ts boots an application context and
   * delegates here — adding a new ACTION = one more case + one more trigger
   * method on this service. No bootstrap file gets touched.
   */
  async runAction(action: string): Promise<void> {
    // Defensive trim: the switch strict-matches, so a stray trailing space/CR
    // in the ACTION env value must not fall through to "Unknown ACTION".
    switch ((action ?? '').trim()) {
      case 'DETECT_STAGNANT_DI':
        await this.triggerStagnationDetection();
        break;
      case 'SYNC_GOOGLE_SHEETS':
        await this.triggerGoogleSheetsSync();
        break;
      case 'SYNC_ACTIONS_EN_COURS':
        await this.triggerActionsEnCoursSync();
        break;
      case 'SYNC_JIRA_DUE_SOON':
        await this.triggerJiraDueSoonSync();
        break;
      case 'SYNC_JIRA_TASKS':
        await this.triggerJiraTasksSync();
        break;
      case 'TEST_DISCORD_CHANNELS':
        await this.triggerTestDiscordChannels();
        break;
      case 'DIGEST_DI_ARCHIVE_INCOMPLETES':
        await this.triggerDiArchiveIncompletesDigest();
        break;
      case 'REUNION_REMINDER':
        await this.triggerReunionReminder();
        break;
      default:
        this.logger.error(`Unknown ACTION: ${action}`);
    }
  }

  /**
   * Trigger-only — DIGEST_DI_ARCHIVE_INCOMPLETES. Runs a Discord digest
   * summarizing DiArchive rows still marked INCOMPLET (missing bc / bl /
   * devis / facture), grouped by missing document with a few example
   * `refOrigine`s per bucket. READ-ONLY on `DiArchive`; no mutation.
   *
   * Run via `ACTION=DIGEST_DI_ARCHIVE_INCOMPLETES node dist/main`
   * (aliases: `action:digest-di-archive-incompletes[:preprod|:dev]`).
   * A Discord failure is swallowed at the service layer (postEmbed logs
   * + skips), so the action always exits cleanly — a monitorable no-op
   * is preferable to a zombie 08:00 cron.
   */
  async triggerDiArchiveIncompletesDigest() {
    const res = await this.diArchiveDigestService.buildAndSend();
    this.logger.log(
      `DiArchive digest: total=${res.total} facture=${res.missing.facture} bc=${res.missing.bc} bl=${res.missing.bl} devis=${res.missing.devis} posted=${res.posted}`,
    );
  }

  /**
   * Trigger-only — REUNION_REMINDER. Finds meetings starting within the next
   * ~5 min (REUNION_REMINDER_WINDOW_MIN) not yet reminded, atomically claims
   * each (`reminderSent` false→true), and posts ONE Discord reminder each with
   * a deep-link that opens the detail modal. Idempotent: designed to run every
   * 1-2 min (`ACTION=REUNION_REMINDER`, alias `action:reunion-reminder`) without
   * ever double-notifying. Business logic lives in ReunionPVService.
   */
  async triggerReunionReminder() {
    const res = await this.reunionPVService.sendDueReminders();
    this.logger.log(
      `Reunion reminder: candidates=${res.candidates} sent=${res.sent} failed=${res.failed}`,
    );
    if (res.failed > 0) process.exitCode = 1;
  }

  /**
   * Diagnostic — post a self-identifying test embed to EACH of the active env's
   * 5 Discord channels, to visually confirm every webhook points to the right
   * server/channel. Read-only (no DB writes).
   *
   * PROD GUARD: disabled in `production` — no test messages in live channels
   * (the wiring is identical, so dev+preprod OK ⇒ prod OK).
   *
   * Robustness: each channel is sent in its own try/catch — a failure logs +
   * continues, never blocking the others. Sets `process.exitCode = 1` if ≥1
   * channel failed (0 if all 5 OK), so a misconfigured/revoked webhook is
   * caught by the exit code. Returns a summary for testability.
   */
  async triggerTestDiscordChannels(): Promise<{
    skipped: boolean;
    total: number;
    ok: number;
    failed: number;
  }> {
    const nodeEnv = (process.env.NODE_ENV || 'development').trim();

    if (nodeEnv === 'production') {
      this.logger.warn(
        'TEST_DISCORD_CHANNELS désactivé en production — aucun message de test envoyé.',
      );
      return { skipped: true, total: 0, ok: 0, failed: 0 };
    }

    let ok = 0;
    let failed = 0;
    for (const ch of DISCORD_TEST_CHANNELS) {
      const url = (process.env[ch.envVar] || '').trim();
      try {
        if (!url) {
          throw new Error(`webhook non configuré (${ch.envVar})`);
        }
        await this.discordHookService.sendTestEmbed(url, ch.name, nodeEnv);
        ok++;
        this.logger.log(`✅ [${nodeEnv}] canal « ${ch.name} » : envoi OK`);
      } catch (err) {
        failed++;
        this.logger.error(
          `❌ [${nodeEnv}] canal « ${ch.name} » : échec — ${(err as Error)?.message ?? err}`,
        );
      }
    }

    this.logger.log(
      `TEST_DISCORD_CHANNELS [${nodeEnv}] : ${ok}/${DISCORD_TEST_CHANNELS.length} OK, ${failed} échec(s).`,
    );
    if (failed > 0) process.exitCode = 1;
    return { skipped: false, total: DISCORD_TEST_CHANNELS.length, ok, failed };
  }

  /**
   * Trigger-only — SYNC_JIRA_DUE_SOON (Cron 2). NO Jira call: reads the PENDING
   * JiraCronNotification rows (produced by Cron 1 = SYNC_JIRA_TASKS), sends ONE
   * grouped Discord digest, and marks them PROCESSED. Run via
   * `ACTION=SYNC_JIRA_DUE_SOON node dist/main` (alias `action:sync-jira-due-soon`).
   * A delivery failure FAILS the action (rethrown → bootstrap logs "ACTION
   * failed" + sets exitCode 1; rows already reverted to PENDING so nothing is
   * lost). An unconfigured "skipped" run is NOT an error (exit 0).
   */
  async triggerJiraDueSoonSync() {
    const res = await this.jiraCronNotificationService.envoyerNotifications();
    this.logger.log(
      `Jira notif: claimed=${res.claimed} processed=${res.processed} failed=${res.failed}` +
        (res.skipped ? ' (skipped: not configured)' : '') +
        (res.error ? ` (error: ${res.error})` : ''),
    );
    if (res.error || res.failed > 0) {
      throw new Error(
        `Jira notif failed: ${res.error ?? `${res.failed} doc(s) en échec`}`,
      );
    }
  }

  /**
   * Trigger-only — SYNC_JIRA_TASKS. Reads OPEN (TODO/IN-PROGRESS) Jira tasks due
   * within ~24h and upserts each as a daily PENDING JiraCronNotification
   * (dedupeKey `issueKey:YYYY-MM-DD`). Run via
   * `ACTION=SYNC_JIRA_TASKS node dist/main` (alias `action:sync-jira-tasks`),
   * scheduled hourly by the system crontab. A Jira API failure FAILS the action:
   * it's rethrown so the bootstrap logs "ACTION failed" and sets
   * `process.exitCode = 1` (the context still closes cleanly in its finally) —
   * a monitorable signal, no zombie process. An unconfigured "skipped" run is
   * NOT an error (exit 0).
   */
  async triggerJiraTasksSync() {
    const res = await this.jiraCronNotificationService.syncTaches();
    console.log('🥠[res]:', res);
    this.logger.log(
      `Jira tasks sync: fetched=${res.fetched} inserted=${res.inserted}` +
        (res.skipped ? ' (skipped: not configured)' : '') +
        (res.error ? ` (error: ${res.error})` : ''),
    );
    if (res.error) {
      throw new Error(`Jira tasks sync failed: ${res.error}`);
    }
  }

  /**
   * Trigger-only — every business decision lives in SheetSyncService so
   * the same logic runs via the dedicated SheetSyncScheduler (daily 02:00)
   * AND via `ACTION=SYNC_GOOGLE_SHEETS npm run start:dev`.
   *
   */
  async triggerGoogleSheetsSync() {
    try {
      await this.sheetSyncService.syncAllEntities();
    } catch (err) {
      this.logger.error(
        `Google Sheets sync cron failed: ${(err as Error).stack ?? err}`,
      );
    }
  }

  /**
   * Refresh ONLY the live snapshot tab(s) ("Actions en cours") without
   * re-appending the daily log tabs. Run via
   * `ACTION=SYNC_ACTIONS_EN_COURS npm run start:dev` or a tighter cron — safe
   * to fire often since snapshot writes overwrite, never duplicate.
   */
  async triggerActionsEnCoursSync() {
    try {
      await this.sheetSyncService.syncSnapshotEntities();
    } catch (err) {
      this.logger.error(
        `Actions-en-cours snapshot sync failed: ${(err as Error).stack ?? err}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_10_HOURS)
  async emptyAudit() {
    this.auditService.emptyAudit();
  }

  @Cron(CronExpression.EVERY_10_HOURS)
  async handleNotOpenedDi() {
    const result = await this.diService.getAllNotOpeneddi();
    if (result.length === 0) {
      this.logger.debug('All DI are opned');
    }
    this.logger.debug('cron start');
    // this.sendReminder(result); REMINDER
  }

  /**
   * Daily stagnation reminder — runs once a day at 08:00 Africa/Tunis. Detection
   * logic lives in StagnationService (same method runs via cron, the ACTION
   * runtime `ACTION=DETECT_STAGNANT_DI`, or a future "run now" button). It
   * persists/escalates alerts SILENTLY, then this sends ONE grouped Discord
   * digest (24h / 72h / >7j) — no per-DI spam. Errors are caught so a transient
   * DB/webhook issue can't break the cron loop; a 0-stagnant day sends nothing.
   */
  @Cron('0 8 * * *', { timeZone: 'Africa/Tunis' })
  async triggerStagnationDetection() {
    try {
      const result = await this.stagnationService.detectStagnantDi();
      const total = result.buckets.reduce((sum, b) => sum + b.count, 0);
      if (total > 0) {
        await this.discordHookService.sendStagnationDigest({
          total,
          buckets: result.buckets,
        });
        this.logger.log(
          `Stagnation digest sent · total=${total} · ` +
            result.buckets.map((b) => `${b.type}=${b.count}`).join(' '),
        );
      } else {
        this.logger.log('Stagnation digest skipped · 0 stagnant DI');
      }
    } catch (err) {
      this.logger.error(
        `Stagnation cron failed: ${(err as Error).stack ?? err}`,
      );
    }
  }

  // dont create audit for ticket al ready exists
  async sendReminder(di: any) {
    // await this.auditService.deleteDocumentsWithReminderField();
    // Map the input data to match the ReminderDataInput type
    const dataToSend = di.map((el) => {
      return {
        _id: el._id, // Assuming 'title' should map to 'name'
        title: el.title, // Assuming '_id' should be converted to 'value'
      };
    });

    // Log the transformed data
    // Prepare the input data for the service call
    const createAuditInput = {
      reminder: {
        data: dataToSend,
        flag: false, // Set flag as needed, for example, false
      },
    };

    const ids = dataToSend.flatMap((el) => {
      return [el._id];
    });

    const isExist = await this.auditService.findExistingReminders(ids);
    // if (isExist.length === 0) {
    //   // Call the create method in the audit service
    //   // const reminder = await this.auditService.create(createAuditInput);

    //   if (reminder) {
    //     this.notificationsGateway.sendReminder({
    //       message: 'You got reminder',
    //       payload: reminder,
    //     });
    //   }
    // }
  }
}

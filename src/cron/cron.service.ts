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
  ) {}

  /**
   * Central ACTION dispatcher. main.ts boots an application context and
   * delegates here — adding a new ACTION = one more case + one more trigger
   * method on this service. No bootstrap file gets touched.
   */
  async runAction(action: string): Promise<void> {
    switch (action) {
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
      default:
        this.logger.error(`Unknown ACTION: ${action}`);
    }
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
   * Trigger-only — every business decision lives in StagnationService so the
   * same logic can run via cron, the ACTION runtime, or a future manual
   * "run now" admin button. Errors are caught so a transient DB issue can't
   * break the cron loop.
   */
  @Cron(CronExpression.EVERY_10_HOURS)
  async triggerStagnationDetection() {
    try {
      await this.stagnationService.detectStagnantDi();
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

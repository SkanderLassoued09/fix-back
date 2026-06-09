import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PubSub } from 'graphql-subscriptions';
import { AuditService } from 'src/audit/audit.service';
import { DiService } from 'src/di/di.service';
import { Di } from 'src/di/entities/di.entity';
import { NotificationsGateway } from 'src/notification.gateway';
import { StagnationService } from 'src/stagnation/stagnation.service';
import { SheetSyncService } from 'src/google-sheets/sheet-sync.service';

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
      default:
        this.logger.error(`Unknown ACTION: ${action}`);
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

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SheetSyncService } from './sheet-sync.service';

/**
 * Cron-only file. Owns NOTHING besides delegating to SheetSyncService —
 * matches the architecture rule "don't mix cron, DB logic, and mapping".
 *
 * Daily at 02:00 server time. Failures are swallowed at this level so a
 * Sheets outage can't crash the cron loop; the service already logs
 * per-entity successes and failures.
 */
@Injectable()
export class SheetSyncScheduler {
  private readonly logger = new Logger(SheetSyncScheduler.name);

  constructor(private readonly syncService: SheetSyncService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runDailySync(): Promise<void> {
    try {
      await this.syncService.syncAllEntities();
    } catch (err) {
      this.logger.error(
        `Daily Google Sheets sync crashed: ${(err as Error).stack ?? err}`,
      );
    }
  }
}

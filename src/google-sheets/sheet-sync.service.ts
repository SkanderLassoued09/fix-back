import { Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleSheetsClient } from './google-sheets.client';
import {
  IGoogleSheetMapper,
  SHEET_MAPPERS,
} from './mappers/google-sheet-mapper.interface';

/**
 * Orchestrator. Walks the registered mappers, fetches + maps + appends
 * per entity, never lets one failure break another.
 *
 * Pure orchestration — no DB queries, no row mapping, no cron decorator.
 * That separation is what keeps the architecture extensible: adding a
 * new entity = a new mapper file + one line in GoogleSheetsModule.
 */
@Injectable()
export class SheetSyncService {
  private readonly logger = new Logger(SheetSyncService.name);

  constructor(
    @Inject(SHEET_MAPPERS)
    private readonly mappers: IGoogleSheetMapper<any>[],
    private readonly sheets: GoogleSheetsClient,
  ) {}

  /**
   * Run every mapper in sequence. Per-entity try/catch isolates failures
   * — a Sheets-API outage for one tab doesn't break another. Returns a
   * summary so cron/ACTION callers can log results.
   */
  async syncAllEntities(): Promise<SheetSyncSummary> {
    this.logger.log(
      `START syncAllEntities · mappers=${this.mappers.map((m) => m.entityName).join(', ')}`,
    );
    const startedAt = Date.now();
    const summary: SheetSyncSummary = { successes: [], failures: [], totalRows: 0 };

    for (const mapper of this.mappers) {
      const tag = mapper.entityName;
      try {
        const entities = await mapper.fetch();
        this.logger.log(`[${tag}] fetched ${entities.length} entity(ies)`);

        if (!entities.length) {
          summary.successes.push({ entity: tag, rows: 0 });
          continue;
        }

        const rows = entities.map((e) => mapper.mapToSheetRow(e));
        await this.sheets.appendRows(mapper.range, rows, mapper.headerRow);

        summary.successes.push({ entity: tag, rows: rows.length });
        summary.totalRows += rows.length;
        this.logger.log(`[${tag}] appended ${rows.length} row(s) to ${mapper.range}`);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        summary.failures.push({ entity: tag, message });
        this.logger.error(`[${tag}] sync failed: ${message}`);
        // intentional: continue to the next mapper
      }
    }

    const elapsedMs = Date.now() - startedAt;
    summary.elapsedMs = elapsedMs;
    this.logger.log(
      `END syncAllEntities · totalRows=${summary.totalRows} ` +
        `successes=${summary.successes.length} failures=${summary.failures.length} ` +
        `elapsedMs=${elapsedMs}`,
    );
    return summary;
  }
}

export interface SheetSyncSummary {
  successes: { entity: string; rows: number }[];
  failures: { entity: string; message: string }[];
  totalRows: number;
  elapsedMs?: number;
}

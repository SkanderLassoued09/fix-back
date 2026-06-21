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
    return this.runMappers(this.mappers, 'syncAllEntities');
  }

  /**
   * Run ONLY the 'snapshot' mappers (e.g. "Actions en cours"). Lets the live
   * view refresh on its own cadence / ACTION without re-appending the daily
   * log tabs (which would duplicate rows in Sheet1).
   */
  async syncSnapshotEntities(): Promise<SheetSyncSummary> {
    const snapshots = this.mappers.filter((m) => m.mode === 'snapshot');
    return this.runMappers(snapshots, 'syncSnapshotEntities');
  }

  private async runMappers(
    mappers: IGoogleSheetMapper<any>[],
    label: string,
  ): Promise<SheetSyncSummary> {
    this.logger.log(
      `START ${label} · mappers=${mappers.map((m) => m.entityName).join(', ') || '(none)'}`,
    );
    const startedAt = Date.now();
    const summary: SheetSyncSummary = { successes: [], failures: [], totalRows: 0 };

    for (const mapper of mappers) {
      const tag = mapper.entityName;
      try {
        const entities = await mapper.fetch();
        this.logger.log(`[${tag}] fetched ${entities.length} entity(ies)`);
        const rows = entities.map((e) => mapper.mapToSheetRow(e));

        if (mapper.mode === 'snapshot') {
          // Always write (even 0 rows) so the tab is cleared when nothing is
          // in progress — keeps the live view truthful.
          await this.sheets.replaceRows(mapper.range, rows, mapper.headerRow);
          this.logger.log(`[${tag}] snapshot wrote ${rows.length} row(s) to ${mapper.range}`);
        } else {
          if (!rows.length) {
            summary.successes.push({ entity: tag, rows: 0 });
            continue;
          }
          await this.sheets.appendRows(mapper.range, rows, mapper.headerRow);
          this.logger.log(`[${tag}] appended ${rows.length} row(s) to ${mapper.range}`);
        }

        summary.successes.push({ entity: tag, rows: rows.length });
        summary.totalRows += rows.length;
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
      `END ${label} · totalRows=${summary.totalRows} ` +
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

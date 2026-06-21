/**
 * Generic contract every entity-sync mapper must implement.
 *
 *   - entityName  → human label used in logs ("DI", "Stats", …)
 *   - range       → A1 range in the spreadsheet where rows are appended.
 *                   Each mapper targets its own tab so column layouts can
 *                   diverge per entity (DI uses A:U, Stats uses A:F, etc.).
 *   - fetch()     → returns the entities to sync for THIS run. Mappers
 *                   typically scope by date window so the daily cron only
 *                   appends what's new — avoids duplicates without
 *                   maintaining sync-state in another collection.
 *   - mapToSheetRow(e) → flat array of cells, matching the tab's header
 *                       order. Mappers MUST return real DB values, the
 *                       empty string for missing fields, or the literal
 *                       'N/A' for fields the DB cannot supply. NEVER
 *                       fabricate.
 *   - uniqueKey(e) → optional natural key for dedupe / future cross-run
 *                   diffing. May return null when no stable key exists.
 */
export interface IGoogleSheetMapper<T> {
  readonly entityName: string;
  readonly range: string;
  /**
   * 'append' (default) → incremental daily log via values.append (scope
   * fetch() by a date window to avoid duplicates). 'snapshot' → a LIVE view
   * ("Actions en cours"): the tab is cleared + rewritten with the full
   * current set each run, so it never duplicates and always reflects now.
   */
  readonly mode?: 'append' | 'snapshot';
  /**
   * Optional header row. When provided, the client writes it as the FIRST
   * row whenever it has to auto-create the target tab — keeps freshly
   * created tabs self-documenting. Length should match mapToSheetRow().
   */
  readonly headerRow?: string[];
  fetch(): Promise<T[]>;
  mapToSheetRow(entity: T): (string | number | boolean)[];
  uniqueKey(entity: T): string | null;
}

/** DI injection token for the array of registered mappers. */
export const SHEET_MAPPERS = Symbol('SHEET_MAPPERS');

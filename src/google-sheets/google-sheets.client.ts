import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import { GoogleOAuthService } from '../google-auth/google-auth.service';

/**
 * Thin client around the Google Sheets v4 API. Owns:
 *   - lazy authentication via the shared **OAuth 2.0** grant (same Gmail account
 *     as Google Drive — see `GoogleOAuthService`; NO service account)
 *   - batched `values.append` (respects Sheets per-request size limits)
 *   - exponential retry on transient failures (429 / 5xx)
 *
 * Has NO knowledge of mappers or business entities — accepts a range +
 * rows and writes them. Mappers compose their own row shapes.
 */
@Injectable()
export class GoogleSheetsClient implements OnModuleInit {
  private readonly logger = new Logger(GoogleSheetsClient.name);
  private sheets: sheets_v4.Sheets | null = null;

  /** Hard ceiling so a single mapper run can't blow the Sheets API limits. */
  private static readonly CHUNK_SIZE = 1000;
  private static readonly MAX_ATTEMPTS = 3;

  constructor(private readonly oauth: GoogleOAuthService) {}

  async onModuleInit() {
    // Best-effort auth bootstrap — failure is non-fatal so the rest of the
    // app boots even when credentials are absent in dev. Each call later
    // re-checks and logs the right error.
    try {
      await this.ensureClient();
    } catch (err) {
      this.logger.warn(
        `Google Sheets auth not initialized at boot: ${(err as Error).message}. ` +
          `Run the OAuth consent flow (GET /auth/google) — the refresh token is stored in MongoDB (oauth_tokens) to enable sync.`,
      );
    }
  }

  private async ensureClient(): Promise<sheets_v4.Sheets> {
    if (this.sheets) return this.sheets;

    // OAuth 2.0 — the SAME Gmail grant Google Drive uses (shared factory). The
    // account owns the spreadsheets, so no service-account sharing is needed.
    // Async now: the refresh token is read from MongoDB (oauth_tokens).
    const auth = await this.oauth.getAuthenticatedClient();
    this.sheets = google.sheets({ version: 'v4', auth });
    return this.sheets;
  }

  /**
   * Append `rows` to `range`. No-op when rows is empty so mappers don't
   * need an outer guard. If the target tab doesn't exist yet, the call
   * auto-creates it (seeding the optional `headerRow` as row 1) and
   * retries once — keeps fresh-spreadsheet onboarding zero-config.
   */
  async appendRows(
    range: string,
    rows: (string | number | boolean)[][],
    headerRow?: string[],
  ): Promise<void> {
    if (!rows.length) {
      this.logger.log(`appendRows skipped (empty) · range=${range}`);
      return;
    }

    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      throw new Error('GOOGLE_SHEETS_ID env var is required for Google Sheets sync');
    }

    const sheets = await this.ensureClient();
    let appended = 0;
    let tabHealed = false; // ensure we only attempt auto-create once per call

    for (let i = 0; i < rows.length; i += GoogleSheetsClient.CHUNK_SIZE) {
      const slice = rows.slice(i, i + GoogleSheetsClient.CHUNK_SIZE);
      try {
        await this.callWithRetry(`append ${range}`, () =>
          sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: slice },
          }),
        );
      } catch (err) {
        // Self-healing: Sheets responds with 400 "Unable to parse range"
        // when the target tab doesn't exist yet. Auto-create + retry once.
        if (!tabHealed && this.isMissingTabError(err)) {
          tabHealed = true;
          const tabName = this.extractTabName(range);
          if (tabName) {
            await this.ensureTab(sheets, spreadsheetId, tabName, headerRow);
            await sheets.spreadsheets.values.append({
              spreadsheetId,
              range,
              valueInputOption: 'RAW',
              insertDataOption: 'INSERT_ROWS',
              requestBody: { values: slice },
            });
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      appended += slice.length;
    }

    this.logger.log(`appendRows · range=${range} · rows=${appended}`);
  }

  /**
   * Snapshot write: CLEAR the target tab, then write `headerRow` (if any)
   * followed by all `rows` starting at A1. Used by 'snapshot' mappers like
   * "Actions en cours" so the tab always mirrors the current set with no
   * duplication. Auto-creates the tab if missing.
   */
  async replaceRows(
    range: string,
    rows: (string | number | boolean)[][],
    headerRow?: string[],
  ): Promise<void> {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      throw new Error('GOOGLE_SHEETS_ID env var is required for Google Sheets sync');
    }
    const sheets = await this.ensureClient();
    const tabName = this.extractTabName(range);
    if (!tabName) throw new Error(`replaceRows: cannot parse tab from "${range}"`);

    await this.ensureTab(sheets, spreadsheetId, tabName, headerRow);

    // Clear the whole tab, then write header + rows from A1 in one update.
    await this.callWithRetry(`clear ${tabName}`, () =>
      sheets.spreadsheets.values.clear({ spreadsheetId, range: tabName }),
    );
    const values = [...(headerRow?.length ? [headerRow] : []), ...rows];
    if (!values.length) {
      this.logger.log(`replaceRows · ${tabName} · cleared (no rows)`);
      return;
    }
    await this.callWithRetry(`replace ${tabName}`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values },
      }),
    );
    this.logger.log(`replaceRows · ${tabName} · rows=${rows.length}`);
  }

  /** Create the tab if absent; seed `headerRow` as row 1 when provided. */
  private async ensureTab(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    tabName: string,
    headerRow?: string[],
  ): Promise<void> {
    const meta = await this.callWithRetry(`get meta`, () =>
      sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties(title)',
      }),
    );
    const existing =
      meta.data.sheets?.some((s) => s.properties?.title === tabName) ?? false;
    if (existing) return;

    this.logger.log(`Auto-creating missing tab "${tabName}"`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });

    if (headerRow?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headerRow] },
      });
      this.logger.log(`Seeded header row on "${tabName}" (${headerRow.length} cols)`);
    }
  }

  private isMissingTabError(err: unknown): boolean {
    const code = (err as any)?.code ?? (err as any)?.response?.status;
    const message =
      (err as any)?.errors?.[0]?.message ??
      (err as any)?.response?.data?.error?.message ??
      (err as any)?.message ??
      '';
    return code === 400 && /Unable to parse range/i.test(String(message));
  }

  private extractTabName(range: string): string | null {
    // Accepts "Tab!A:U", "Tab!A1:U", "'Tab With Space'!A:U" …
    const match = range.match(/^'?(.+?)'?!/);
    return match ? match[1] : null;
  }

  /**
   * Retry helper for transient Sheets failures. Retries 429 (rate limit)
   * and 5xx; bails immediately on 4xx (caller error like bad range or
   * missing permissions — retrying won't help and would just delay logs).
   */
  private async callWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= GoogleSheetsClient.MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const code = (err as any)?.code ?? (err as any)?.response?.status;
        const isTransient =
          code === 429 || (typeof code === 'number' && code >= 500 && code < 600);

        if (!isTransient || attempt === GoogleSheetsClient.MAX_ATTEMPTS) {
          break;
        }
        const backoffMs = 2 ** (attempt - 1) * 1000;
        this.logger.warn(
          `${label} attempt ${attempt} failed (code=${code}); retrying in ${backoffMs}ms`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw this.clarifyScopeError(lastErr);
  }

  /**
   * Turn Google's opaque 403 "insufficient authentication scopes" into an
   * actionable message: the shared OAuth refresh token predates the Sheets
   * scope and must be re-consented (Drive alone won't grant Sheets access).
   * Non-scope errors pass through unchanged.
   */
  private clarifyScopeError(err: unknown): unknown {
    const code = (err as any)?.code ?? (err as any)?.response?.status;
    const status = (err as any)?.response?.data?.error?.status;
    const message = String(
      (err as any)?.response?.data?.error?.message ??
        (err as any)?.errors?.[0]?.message ??
        (err as any)?.message ??
        '',
    );
    const insufficientScope =
      code === 403 &&
      (/insufficient/i.test(message) ||
        /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message) ||
        status === 'PERMISSION_DENIED');
    if (insufficientScope) {
      return new Error(
        "Google Sheets: le refresh token OAuth ne couvre pas le scope 'spreadsheets'. " +
          'Relancez le consentement (GET /auth/google) avec le compte Gmail propriétaire ' +
          'pour régénérer un refresh token couvrant Drive + Sheets — il sera re-stocké en base (oauth_tokens).',
      );
    }
    return err;
  }
}

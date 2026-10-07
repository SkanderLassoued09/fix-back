import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import { GoogleOAuthService } from '../google-auth/google-auth.service';
import { withErrorContext, reportCatchError } from '../common/error-context';

/** Une cellule mise en forme pour `writeFormattedTab`. */
export interface SheetCell {
  value?: string | number | Date | null;
  /** Couleur de fond `RRGGBB` (sans #). */
  background?: string | null;
  bold?: boolean;
  fontSize?: number;
  align?: 'LEFT' | 'CENTER' | 'RIGHT';
  /** Texte qui déborde sur les cellules vides voisines au lieu de passer à la ligne. */
  overflow?: boolean;
  /** Liens DANS la cellule : chaque `text` doit apparaître dans `value`. */
  links?: Array<{ text: string; url: string }>;
}

/** Mise en page d'un onglet réécrit par `writeFormattedTab`. */
export interface SheetLayout {
  frozenRows?: number;
  frozenColumns?: number;
  /** Largeur en pixels, par colonne (index 0 = A). */
  columnWidths?: number[];
  /** Fusions sur une ligne : colonnes [fromCol, toCol[ (0-based). */
  merges?: Array<{ row: number; fromCol: number; toCol: number }>;
  /** Ligne d'en-tête (0-based) du filtre ; filtre posé jusqu'à la dernière ligne. */
  filterHeaderRow?: number;
  /** Bordures fines sur les lignes [fromRow, fin[ et toutes les colonnes. */
  bordersFromRow?: number;
}

/** Série Google Sheets (jours depuis 1899-12-30) d'une date « civile » UTC. */
function toSheetSerial(d: Date): number {
  try {
    return d.getTime() / 86400000 + 25569;
  } catch (error) {
    throw withErrorContext(error, 'toSheetSerial');
  }
}

function hexColor(hex: string): sheets_v4.Schema$Color {
  try {
    const h = hex.replace('#', '');
    return {
      red: parseInt(h.slice(0, 2), 16) / 255,
      green: parseInt(h.slice(2, 4), 16) / 255,
      blue: parseInt(h.slice(4, 6), 16) / 255,
    };
  } catch (error) {
    throw withErrorContext(error, 'hexColor');
  }
}

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
      reportCatchError(err, 'GoogleSheetsClient.onModuleInit');
      this.logger.warn(
        `Google Sheets auth not initialized at boot: ${(err as Error).message}. ` +
          `Run the OAuth consent flow (GET /auth/google) — the refresh token is stored in MongoDB (oauth_tokens) to enable sync.`,
      );
    }
  }

  private async ensureClient(): Promise<sheets_v4.Sheets> {
    try {
      if (this.sheets) return this.sheets;

      // OAuth 2.0 — the SAME Gmail grant Google Drive uses (shared factory). The
      // account owns the spreadsheets, so no service-account sharing is needed.
      // Async now: the refresh token is read from MongoDB (oauth_tokens).
      const auth = await this.oauth.getAuthenticatedClient();
      this.sheets = google.sheets({ version: 'v4', auth });
      return this.sheets;
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.ensureClient');
    }
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
    // Cible optionnelle : par défaut le classeur d'export (`GOOGLE_SHEETS_ID`).
    // Le rapport de stagnation quotidien passe `GOOGLE_STAGNATION_SHEETS_ID`.
    spreadsheetId: string = process.env.GOOGLE_SHEETS_ID ?? '',
  ): Promise<void> {
    try {
      if (!rows.length) {
        this.logger.log(`appendRows skipped (empty) · range=${range}`);
        return;
      }

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
          reportCatchError(err, 'GoogleSheetsClient.appendRows');
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
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.appendRows');
    }
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
    try {
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
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.replaceRows');
    }
  }

  /**
   * Réécrit ENTIÈREMENT un onglet — valeurs, couleurs, liens, mise en page — en
   * UN SEUL `batchUpdate` (atomique : jamais d'onglet à moitié écrit visible).
   *
   * L'onglet est créé s'il manque. Cas particulier : un classeur neuf dont le
   * seul onglet est l'onglet par défaut VIDE (« Sheet1 » / « Feuille 1 ») est
   * RENOMMÉ plutôt que laissé à côté. Rien d'autre du classeur n'est touché.
   * Retourne le `sheetId` (gid) de l'onglet.
   */
  async writeFormattedTab(
    spreadsheetId: string,
    tabName: string,
    grid: SheetCell[][],
    layout: SheetLayout = {},
  ): Promise<number> {
    try {
      const sheets = await this.ensureClient();
      const sheetId = await this.ensureNamedTab(sheets, spreadsheetId, tabName);

      const meta = await this.callWithRetry(`get grid ${tabName}`, () =>
        sheets.spreadsheets.get({
          spreadsheetId,
          fields: 'sheets(properties(sheetId,gridProperties),basicFilter)',
        }),
      );
      const sheet = meta.data.sheets?.find(
        (s) => s.properties?.sheetId === sheetId,
      );
      const gridRows = sheet?.properties?.gridProperties?.rowCount ?? 1000;
      const gridCols = sheet?.properties?.gridProperties?.columnCount ?? 26;
      const numCols = Math.max(1, ...grid.map((r) => r.length));

      const requests: sheets_v4.Schema$Request[] = [];
      // Place pour toutes les lignes (+ marge) et colonnes.
      if (grid.length + 20 > gridRows || numCols > gridCols) {
        requests.push({
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: {
                rowCount: Math.max(gridRows, grid.length + 50),
                columnCount: Math.max(gridCols, numCols),
              },
            },
            fields: 'gridProperties(rowCount,columnCount)',
          },
        });
      }
      // Remise à zéro : fusions, filtre, puis valeurs + formats de TOUT l'onglet
      // (sinon les lignes d'une DI supprimée resteraient sous la dernière ligne).
      requests.push({ unmergeCells: { range: { sheetId } } });
      if (sheet?.basicFilter) requests.push({ clearBasicFilter: { sheetId } });
      requests.push({
        updateCells: {
          range: { sheetId },
          fields: 'userEnteredValue,userEnteredFormat,textFormatRuns',
        },
      });
      requests.push({
        updateCells: {
          start: { sheetId, rowIndex: 0, columnIndex: 0 },
          rows: grid.map((row) => ({ values: row.map((c) => this.toCellData(c)) })),
          fields: 'userEnteredValue,userEnteredFormat,textFormatRuns',
        },
      });

      for (const m of layout.merges ?? []) {
        requests.push({
          mergeCells: {
            range: {
              sheetId,
              startRowIndex: m.row,
              endRowIndex: m.row + 1,
              startColumnIndex: m.fromCol,
              endColumnIndex: m.toCol,
            },
            mergeType: 'MERGE_ALL',
          },
        });
      }
      if (typeof layout.bordersFromRow === 'number' && grid.length > layout.bordersFromRow) {
        const thin = { style: 'SOLID', color: hexColor('000000') };
        requests.push({
          updateBorders: {
            range: {
              sheetId,
              startRowIndex: layout.bordersFromRow,
              endRowIndex: grid.length,
              startColumnIndex: 0,
              endColumnIndex: numCols,
            },
            top: thin,
            bottom: thin,
            left: thin,
            right: thin,
            innerHorizontal: thin,
            innerVertical: thin,
          },
        });
      }
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: {
              frozenRowCount: layout.frozenRows ?? 0,
              frozenColumnCount: layout.frozenColumns ?? 0,
            },
          },
          fields: 'gridProperties(frozenRowCount,frozenColumnCount)',
        },
      });
      (layout.columnWidths ?? []).forEach((px, i) => {
        requests.push({
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
            properties: { pixelSize: px },
            fields: 'pixelSize',
          },
        });
      });
      if (typeof layout.filterHeaderRow === 'number' && grid.length > layout.filterHeaderRow) {
        requests.push({
          setBasicFilter: {
            filter: {
              range: {
                sheetId,
                startRowIndex: layout.filterHeaderRow,
                endRowIndex: grid.length,
                startColumnIndex: 0,
                endColumnIndex: numCols,
              },
            },
          },
        });
      }

      await this.callWithRetry(`write formatted ${tabName}`, () =>
        sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
      );
      this.logger.log(`writeFormattedTab · ${tabName} · rows=${grid.length}`);
      return sheetId;
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.writeFormattedTab');
    }
  }

  /** Onglet `tabName` → son sheetId ; le crée (ou renomme l'onglet par défaut
   *  VIDE d'un classeur neuf) s'il manque. */
  private async ensureNamedTab(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    tabName: string,
  ): Promise<number> {
    try {
      const meta = await this.callWithRetry('get tabs', () =>
        sheets.spreadsheets.get({
          spreadsheetId,
          fields: 'sheets.properties(sheetId,title)',
        }),
      );
      const tabs = (meta.data.sheets ?? []).map((s) => s.properties ?? {});
      const found = tabs.find((t) => t.title === tabName);
      if (typeof found?.sheetId === 'number') return found.sheetId;

      const only = tabs.length === 1 ? tabs[0] : null;
      if (
        only &&
        typeof only.sheetId === 'number' &&
        /^(Sheet1|Feuille 1|Feuil1)$/i.test(only.title ?? '')
      ) {
        const probe = await this.callWithRetry('probe default tab', () =>
          sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `'${only.title}'!A1:Z20`,
          }),
        );
        if (!(probe.data.values ?? []).length) {
          await this.callWithRetry(`rename default tab → ${tabName}`, () =>
            sheets.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: {
                requests: [
                  {
                    updateSheetProperties: {
                      properties: { sheetId: only.sheetId, title: tabName },
                      fields: 'title',
                    },
                  },
                ],
              },
            }),
          );
          this.logger.log(`Renamed empty default tab "${only.title}" → "${tabName}"`);
          return only.sheetId;
        }
      }

      const res = await this.callWithRetry(`add tab ${tabName}`, () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
        }),
      );
      const id = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
      if (typeof id !== 'number') throw new Error(`addSheet "${tabName}" sans sheetId`);
      this.logger.log(`Created tab "${tabName}" (${id})`);
      return id;
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.ensureNamedTab');
    }
  }

  private toCellData(c: SheetCell): sheets_v4.Schema$CellData {
    try {
      const fmt: sheets_v4.Schema$CellFormat = {
        verticalAlignment: 'MIDDLE',
        wrapStrategy: c.overflow ? 'OVERFLOW_CELL' : 'WRAP',
      };
      if (c.background) fmt.backgroundColor = hexColor(c.background);
      if (c.align) fmt.horizontalAlignment = c.align;
      if (c.bold || c.fontSize) {
        fmt.textFormat = {
          ...(c.bold ? { bold: true } : {}),
          ...(c.fontSize ? { fontSize: c.fontSize } : {}),
        };
      }
      const cell: sheets_v4.Schema$CellData = { userEnteredFormat: fmt };
      const v = c.value;
      if (v instanceof Date) {
        cell.userEnteredValue = { numberValue: toSheetSerial(v) };
        fmt.numberFormat = { type: 'DATE', pattern: 'dd/mm/yyyy' };
      } else if (typeof v === 'number') {
        cell.userEnteredValue = { numberValue: v };
      } else if (v !== null && v !== undefined && v !== '') {
        const text = String(v);
        cell.userEnteredValue = { stringValue: text };
        const runs = this.linkRuns(text, c.links ?? []);
        if (runs.length) cell.textFormatRuns = runs;
      }
      return cell;
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.toCellData');
    }
  }

  /** Runs de lien : chaque `text` lié à son url, le reste sans lien. */
  private linkRuns(
    text: string,
    links: Array<{ text: string; url: string }>,
  ): sheets_v4.Schema$TextFormatRun[] {
    try {
      const runs: sheets_v4.Schema$TextFormatRun[] = [];
      let from = 0;
      for (const l of links) {
        const at = text.indexOf(l.text, from);
        if (at < 0 || !l.url) continue;
        if (at > from) runs.push({ startIndex: from, format: {} });
        runs.push({ startIndex: at, format: { link: { uri: l.url } } });
        from = at + l.text.length;
      }
      if (runs.length && from < text.length) runs.push({ startIndex: from, format: {} });
      // L'API refuse un run qui démarre à la fin du texte, ou deux runs au même index.
      return runs.filter(
        (r, i) => (r.startIndex ?? 0) < text.length && runs.findIndex((x) => x.startIndex === r.startIndex) === i,
      );
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.linkRuns');
    }
  }

  /**
   * Résout le `gid` (sheetId) d'un onglet par son NOM — pour construire un lien
   * PROFOND vers cet onglet (`…/edit?gid=<gid>#gid=<gid>`). Retourne `null` si le
   * classeur ou l'onglet est introuvable (l'appelant retombe sur le lien classeur).
   */
  async getSheetGid(
    spreadsheetId: string,
    tabName: string,
  ): Promise<number | null> {
    try {
      if (!spreadsheetId || !tabName) return null;
      const sheets = await this.ensureClient();
      const meta = await this.callWithRetry(`get gid ${tabName}`, () =>
        sheets.spreadsheets.get({
          spreadsheetId,
          fields: 'sheets.properties(sheetId,title)',
        }),
      );
      const found = meta.data.sheets?.find(
        (s) => s.properties?.title === tabName,
      );
      const gid = found?.properties?.sheetId;
      return typeof gid === 'number' ? gid : null;
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.getSheetGid');
    }
  }

  /** Create the tab if absent; seed `headerRow` as row 1 when provided. */
  private async ensureTab(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    tabName: string,
    headerRow?: string[],
  ): Promise<void> {
    try {
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
      const addRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: tabName } } }],
        },
      });
      const newSheetId =
        addRes.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;

      if (headerRow?.length) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tabName}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headerRow] },
        });
        this.logger.log(`Seeded header row on "${tabName}" (${headerRow.length} cols)`);

        // Mise en forme de l'entête (fond coloré + texte blanc gras + ligne figée).
        // Best-effort : un échec de STYLE ne doit jamais bloquer l'écriture des
        // données (le style est cosmétique, la donnée est l'essentiel).
        if (typeof newSheetId === 'number') {
          try {
            await this.styleHeaderRow(
              sheets,
              spreadsheetId,
              newSheetId,
              headerRow.length,
            );
          } catch (err) {
            reportCatchError(err, 'GoogleSheetsClient.ensureTab');
            this.logger.warn(
              `Header styling skipped on "${tabName}": ${(err as Error).message}`,
            );
          }
        }
      }
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.ensureTab');
    }
  }

  /**
   * Colore + met en gras la ligne d'entête (ligne 1) et la fige. Appelée UNE
   * SEULE FOIS, à la création de l'onglet (dans `ensureTab`) — jamais réappliquée
   * aux ajouts suivants. Cosmétique : best-effort (voir l'appelant).
   */
  private async styleHeaderRow(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetId: number,
    numCols: number,
  ): Promise<void> {
    try {
      await this.callWithRetry(`style header (sheetId=${sheetId})`, () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: numCols,
                  },
                  cell: {
                    userEnteredFormat: {
                      // Entête BLEU (#1a73e8) · texte blanc gras. SEULE la ligne
                      // d'entête est colorée — les lignes de données restent sans
                      // couleur (aucun autre style appliqué).
                      backgroundColor: { red: 0.102, green: 0.451, blue: 0.91 },
                      horizontalAlignment: 'CENTER',
                      verticalAlignment: 'MIDDLE',
                      textFormat: {
                        foregroundColor: { red: 1, green: 1, blue: 1 },
                        bold: true,
                        fontSize: 11,
                      },
                    },
                  },
                  fields:
                    'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)',
                },
              },
              {
                updateSheetProperties: {
                  properties: {
                    sheetId,
                    gridProperties: { frozenRowCount: 1 },
                  },
                  fields: 'gridProperties.frozenRowCount',
                },
              },
            ],
          },
        }),
      );
      this.logger.log(`Styled + froze header row on sheetId=${sheetId}`);
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.styleHeaderRow');
    }
  }

  private isMissingTabError(err: unknown): boolean {
    try {
      const code = (err as any)?.code ?? (err as any)?.response?.status;
      const message =
        (err as any)?.errors?.[0]?.message ??
        (err as any)?.response?.data?.error?.message ??
        (err as any)?.message ??
        '';
      return code === 400 && /Unable to parse range/i.test(String(message));
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.isMissingTabError');
    }
  }

  private extractTabName(range: string): string | null {
    try {
      // Accepts "Tab!A:U", "Tab!A1:U", "'Tab With Space'!A:U" …
      const match = range.match(/^'?(.+?)'?!/);
      return match ? match[1] : null;
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.extractTabName');
    }
  }

  /**
   * Retry helper for transient Sheets failures. Retries 429 (rate limit)
   * and 5xx; bails immediately on 4xx (caller error like bad range or
   * missing permissions — retrying won't help and would just delay logs).
   */
  private async callWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= GoogleSheetsClient.MAX_ATTEMPTS; attempt++) {
        try {
          return await fn();
        } catch (err) {
          reportCatchError(err, 'GoogleSheetsClient.callWithRetry');
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
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.callWithRetry');
    }
  }

  /**
   * Turn Google's opaque 403 "insufficient authentication scopes" into an
   * actionable message: the shared OAuth refresh token predates the Sheets
   * scope and must be re-consented (Drive alone won't grant Sheets access).
   * Non-scope errors pass through unchanged.
   */
  private clarifyScopeError(err: unknown): unknown {
    try {
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
    } catch (error) {
      throw withErrorContext(error, 'GoogleSheetsClient.clarifyScopeError');
    }
  }
}

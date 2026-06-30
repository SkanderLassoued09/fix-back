import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as XLSX from 'xlsx';
import { DiService } from '../di.service';
import { ClientsService } from 'src/clients/clients.service';
import { LocationService } from 'src/location/location.service';

/**
 * Bulk DI import from an .xlsx file — two-phase (dry-run preview → real import).
 *
 * Source columns (header detected BY LABEL, not by position — the real export
 * carries 3 blank title rows so the header sits on row 4):
 *   N° DI | Désignation | N° Série | Client | Date de réception | Rangement
 *
 * Mapping (see the discovery report):
 *   N° DI            → _idnum   (taken AS-IS from the file; the auto counter is
 *                                 NEVER read nor advanced)
 *   Désignation      → title
 *   N° Série         → nSerie   (normalised to a trimmed string; `***`/empty ok)
 *   Client           → client_id (resolved by name, auto-created, idempotent)
 *   Date de réception→ dateReception (DD/MM/YYYY or Excel serial)
 *   Rangement        → location_id (Location resolved by name, find-or-create)
 *   TYPE (absent)    → type_client defaults to 'Client'
 *
 * Policy: invalid rows are IGNORED and reported (not all-or-nothing). Existing
 * refs are NEVER overwritten.
 */

export interface ImportWarning {
  ligne: number;
  message: string;
}
export interface ImportError {
  ligne: number;
  valeurs: Record<string, string>;
  motifs: string[];
}
export interface ImportCrees {
  dis: number;
  clients: number;
  locations: number;
  ignorees: number;
}
export type LigneStatut = 'valide' | 'avertissement' | 'erreur';
/** One processed data row, for the colored preview table on the front. */
export interface ImportLigne {
  ligne: number;
  statut: LigneStatut;
  valeurs: Record<string, string>;
  motifs: string[];
}
export interface ImportReport {
  ligneEnTete: number | null;
  total: number;
  valides: number;
  warnings: ImportWarning[];
  erreurs: ImportError[];
  /** Every non-blank row with its computed status — drives the FE preview. */
  lignes: ImportLigne[];
  /** Set only on a header/structure global reject so the FE can toast cleanly. */
  enTeteInvalide?: boolean;
  /** Present only on a real import (dryRun=false). */
  crees?: ImportCrees;
}

/** The six logical columns. nDi/designation/nSerie/client are MANDATORY columns. */
type ColKey = 'nDi' | 'designation' | 'nSerie' | 'client' | 'date' | 'rangement';

const MANDATORY_COLS: ColKey[] = ['nDi', 'designation', 'nSerie', 'client'];

// Header label aliases (already normalised: lower-case, accent-stripped, single
// spaces). Matching is exact against a normalised header cell, so order/case/
// accents/punctuation in the file don't matter.
const COL_ALIASES: Record<ColKey, string[]> = {
  nDi: ['n di', 'no di', 'numero di', 'num di', 'ndi', 'n di t', 'reference', 'ref'],
  designation: ['designation', 'desgination', 'libelle', 'intitule', 'denomination'],
  nSerie: ['n serie', 'no serie', 'numero serie', 'num serie', 'nserie', 'serie', 'numero de serie', 's n', 'sn'],
  client: ['client', 'clients', 'nom client', 'societe client', 'raison sociale'],
  date: ['date de reception', 'date reception', 'date recue', 'date recu', 'reception', 'date'],
  rangement: ['rangement', 'emplacement', 'localisation', 'location', 'position'],
};

// Human labels reused for the template + error reporting.
export const TEMPLATE_HEADERS = [
  'N° DI',
  'Désignation',
  'N° Série',
  'Client',
  'Date de réception',
  'Rangement',
];

interface ParsedRow {
  ligne: number; // real 1-based Excel row
  nDi: string;
  designation: string;
  nSerie: string;
  clientName: string;
  rangement: string;
  dateValue: Date | null;
  raw: Record<string, string>; // original cell strings, for error echo
}

@Injectable()
export class DiImportService {
  private readonly logger = new Logger(DiImportService.name);

  constructor(
    @InjectModel('Di') private readonly diModel: Model<any>,
    @InjectModel('Client') private readonly clientModel: Model<any>,
    @InjectModel('Location') private readonly locationModel: Model<any>,
    private readonly diService: DiService,
    private readonly clientsService: ClientsService,
    private readonly locationService: LocationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public entrypoints
  // ---------------------------------------------------------------------------

  /** Parse + validate; when dryRun is false, also persist the valid rows. */
  async run(
    buffer: Buffer,
    opts: { dryRun: boolean; createdBy?: string },
  ): Promise<ImportReport> {
    const parsed = this.parse(buffer);
    if (parsed.enTeteInvalide) return parsed.report; // global reject, 0 processed

    const existing = await this.loadExistingRefs();
    const report = this.validate(parsed.rows, existing);
    report.ligneEnTete = parsed.headerLine;

    if (opts.dryRun) return report;

    // Real import — persist only the rows flagged valid by `validate`.
    const crees = await this.persist(parsed.rows, report, opts.createdBy);
    report.crees = crees;
    return report;
  }

  /** Build the downloadable .xlsx model (headers + two example rows). */
  buildTemplate(): Buffer {
    const rows = [
      TEMPLATE_HEADERS,
      ['T1394', 'AGRO NADHOUR', '***', 'COGEMHY', '18/06/2026', 'A28'],
      ['T1345', 'CARTE FOUR', '4821810100', 'PERSO (PROMODAR)', '04/05/2026', 'A15'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 10 }, { wch: 24 }, { wch: 14 }, { wch: 22 }, { wch: 18 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DI');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  // ---------------------------------------------------------------------------
  // Parsing — header detection by label + row extraction with real line numbers
  // ---------------------------------------------------------------------------

  private parse(buffer: Buffer): {
    rows: ParsedRow[];
    headerLine: number | null;
    enTeteInvalide: boolean;
    report: ImportReport;
  } {
    const empty = (msg: string): any => ({
      rows: [],
      headerLine: null,
      enTeteInvalide: true,
      report: {
        ligneEnTete: null,
        total: 0,
        valides: 0,
        warnings: [],
        erreurs: [{ ligne: 0, valeurs: {}, motifs: [msg] }],
        lignes: [],
        enTeteInvalide: true,
      },
    });

    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    } catch {
      return empty('Fichier illisible : .xlsx valide attendu.');
    }
    const sheetName = wb.SheetNames[0];
    const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
    if (!sheet || !sheet['!ref']) {
      return empty('Feuille vide : aucune donnée détectée.');
    }
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const cell = (r: number, c: number): any => {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cl = (sheet as any)[ref];
      return cl ? cl.v : null;
    };

    // 1) Locate the header row: the first row that carries ALL mandatory labels.
    let headerRow = -1;
    let cols: Partial<Record<ColKey, number>> = {};
    for (let r = range.s.r; r <= range.e.r; r++) {
      const found = this.matchHeader(cell, r, range);
      if (found && MANDATORY_COLS.every((k) => found[k] != null)) {
        headerRow = r;
        cols = found;
        break;
      }
    }
    if (headerRow === -1) {
      return empty(
        'En-tête introuvable : colonnes obligatoires manquantes (N° DI, Désignation, N° Série, Client).',
      );
    }

    // 2) Extract data rows (real 1-based Excel line = r + 1). Blank rows skipped.
    const rows: ParsedRow[] = [];
    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const get = (k: ColKey): any =>
        cols[k] != null ? cell(r, cols[k] as number) : null;

      const nDi = this.str(get('nDi'));
      const designation = this.str(get('designation'));
      const nSerie = this.str(get('nSerie'));
      const clientName = this.str(get('client'));
      const rangement = this.str(get('rangement'));
      const dateRaw = get('date');

      // Fully blank row → skip silently (don't count toward total).
      if (!nDi && !designation && !nSerie && !clientName && !rangement && (dateRaw == null || dateRaw === '')) {
        continue;
      }

      rows.push({
        ligne: r + 1,
        nDi,
        designation,
        nSerie,
        clientName,
        rangement,
        dateValue: this.parseDate(dateRaw),
        raw: {
          'N° DI': nDi,
          Désignation: designation,
          'N° Série': nSerie,
          Client: clientName,
          'Date de réception': this.str(dateRaw),
          Rangement: rangement,
        },
      });
    }

    return {
      rows,
      headerLine: headerRow + 1,
      enTeteInvalide: false,
      report: null as any,
    };
  }

  /** Try to resolve every column index from a candidate header row. */
  private matchHeader(
    cell: (r: number, c: number) => any,
    r: number,
    range: XLSX.Range,
  ): Partial<Record<ColKey, number>> {
    const cols: Partial<Record<ColKey, number>> = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const nv = this.norm(cell(r, c));
      if (!nv) continue;
      for (const key of Object.keys(COL_ALIASES) as ColKey[]) {
        if (cols[key] != null) continue;
        if (COL_ALIASES[key].includes(nv)) {
          cols[key] = c;
          break;
        }
      }
    }
    return cols;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private validate(
    rows: ParsedRow[],
    existing: { refs: Set<string>; nextAuto: number },
  ): ImportReport {
    // Intra-file duplicate detection (case-sensitive on the exact ref string).
    const seen = new Map<string, number>();
    for (const row of rows) {
      if (!row.nDi) continue;
      seen.set(row.nDi, (seen.get(row.nDi) ?? 0) + 1);
    }

    const warnings: ImportWarning[] = [];
    const erreurs: ImportError[] = [];
    const lignes: ImportLigne[] = [];
    let valides = 0;

    for (const row of rows) {
      const motifs: string[] = [];

      if (!row.nDi) motifs.push('N° DI manquant');
      if (!row.designation) motifs.push('Désignation manquante');
      if (!row.clientName) motifs.push('Client manquant');
      if (row.nDi && existing.refs.has(row.nDi)) {
        motifs.push(`N° DI « ${row.nDi} » déjà existant en base (non écrasé)`);
      }
      if (row.nDi && (seen.get(row.nDi) ?? 0) > 1) {
        motifs.push(`N° DI « ${row.nDi} » en doublon dans le fichier`);
      }

      if (motifs.length > 0) {
        erreurs.push({ ligne: row.ligne, valeurs: row.raw, motifs });
        lignes.push({ ligne: row.ligne, statut: 'erreur', valeurs: row.raw, motifs });
        continue;
      }

      // Valid row → may still carry non-blocking warnings.
      valides++;
      const rowWarnings: string[] = [];
      if (!/^T\d+$/.test(row.nDi)) {
        rowWarnings.push(`Format de réf « ${row.nDi} » inhabituel (attendu T{n})`);
      }
      const m = row.nDi.match(/^(?:DI|T)(\d+)$/);
      if (m && parseInt(m[1], 10) >= existing.nextAuto) {
        rowWarnings.push(
          `N° DI « ${row.nDi} » ≥ prochaine réf auto-générée (T${existing.nextAuto}) — collision future possible`,
        );
      }
      if (row.raw['Date de réception'] && !row.dateValue) {
        rowWarnings.push(
          `Date de réception « ${row.raw['Date de réception']} » non reconnue (ignorée)`,
        );
      }
      for (const message of rowWarnings) {
        warnings.push({ ligne: row.ligne, message });
      }
      lignes.push({
        ligne: row.ligne,
        statut: rowWarnings.length ? 'avertissement' : 'valide',
        valeurs: row.raw,
        motifs: rowWarnings,
      });
    }

    return {
      ligneEnTete: null,
      total: rows.length,
      valides,
      warnings,
      erreurs,
      lignes,
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence (dryRun=false)
  // ---------------------------------------------------------------------------

  private async persist(
    rows: ParsedRow[],
    report: ImportReport,
    createdBy?: string,
  ): Promise<ImportCrees> {
    // Rows that errored during validation are excluded from the import set.
    const errorLines = new Set(report.erreurs.map((e) => e.ligne));
    const toImport = rows.filter((r) => !errorLines.has(r.ligne));

    const clientCache = await this.buildClientCache();
    const locationCache = await this.buildLocationCache();
    let dis = 0;
    let clientsCreated = 0;
    let locationsCreated = 0;

    for (const row of toImport) {
      try {
        const client = await this.resolveClient(row.clientName, clientCache);
        if (client.created) clientsCreated++;

        let locationId: string | undefined;
        if (row.rangement) {
          const loc = await this.resolveLocation(row.rangement, locationCache);
          locationId = loc.id;
          if (loc.created) locationsCreated++;
        }

        const input: any = {
          title: row.designation,
          nSerie: row.nSerie,
          client_id: client.id,
          location_id: locationId,
          type_client: 'Client',
          status: 'CREATED',
          dateReception: row.dateValue ?? undefined,
          createdBy,
        };
        await this.diService.createDi(input, {
          forcedRef: row.nDi,
          skipNotify: true,
        });
        dis++;
      } catch (err) {
        // A runtime failure on an otherwise-valid row: report it, keep going.
        this.logger.error(
          `Import row ${row.ligne} (${row.nDi}) failed: ${(err as Error)?.message ?? err}`,
        );
        report.erreurs.push({
          ligne: row.ligne,
          valeurs: row.raw,
          motifs: [`Échec de création : ${(err as Error)?.message ?? err}`],
        });
        report.valides = Math.max(0, report.valides - 1);
      }
    }

    return {
      dis,
      clients: clientsCreated,
      locations: locationsCreated,
      ignorees: rows.length - dis,
    };
  }

  // ---------------------------------------------------------------------------
  // Resolution helpers (idempotent within a single import)
  // ---------------------------------------------------------------------------

  private async loadExistingRefs(): Promise<{
    refs: Set<string>;
    nextAuto: number;
  }> {
    const docs = await this.diModel.find({}, { _idnum: 1 }).lean();
    const refs = new Set<string>();
    let max = 0;
    for (const d of docs) {
      const ref = this.str((d as any)?._idnum);
      if (ref) refs.add(ref);
      const m = ref.match(/^(?:DI|T)(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return { refs, nextAuto: max + 1 };
  }

  private async buildClientCache(): Promise<Map<string, string>> {
    const docs = await this.clientModel
      .find({ isDeleted: { $ne: true } }, { _id: 1, first_name: 1, last_name: 1 })
      .lean();
    const map = new Map<string, string>();
    for (const c of docs) {
      const key = this.norm(`${(c as any).first_name ?? ''} ${(c as any).last_name ?? ''}`);
      if (key && !map.has(key)) map.set(key, (c as any)._id);
    }
    return map;
  }

  private async resolveClient(
    name: string,
    cache: Map<string, string>,
  ): Promise<{ id: string; created: boolean }> {
    const key = this.norm(name);
    const hit = cache.get(key);
    if (hit) return { id: hit, created: false };
    const created = await this.clientsService.createClient({
      first_name: name.trim(),
      last_name: '',
    } as any);
    cache.set(key, (created as any)._id);
    return { id: (created as any)._id, created: true };
  }

  private async buildLocationCache(): Promise<Map<string, string>> {
    const docs = await this.locationModel
      .find({ isDeleted: { $ne: true } }, { _id: 1, location_name: 1 })
      .lean();
    const map = new Map<string, string>();
    for (const l of docs) {
      const key = this.norm((l as any).location_name);
      if (key && !map.has(key)) map.set(key, (l as any)._id);
    }
    return map;
  }

  private async resolveLocation(
    rangement: string,
    cache: Map<string, string>,
  ): Promise<{ id: string; created: boolean }> {
    const key = this.norm(rangement);
    const hit = cache.get(key);
    if (hit) return { id: hit, created: false };
    const created = await this.locationService.createlocation({
      location_name: rangement.trim(),
      avaible: true,
    } as any);
    cache.set(key, (created as any)._id);
    return { id: (created as any)._id, created: true };
  }

  // ---------------------------------------------------------------------------
  // Primitives
  // ---------------------------------------------------------------------------

  /** Normalise a label / name: lower-case, strip accents, collapse to spaces. */
  private norm(s: any): string {
    return String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /** Normalise a cell to a trimmed string (numbers → plain integer string). */
  private str(v: any): string {
    if (v == null) return '';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
    if (typeof v === 'number') {
      // Avoid scientific notation for serials like 4821810100.
      return Number.isInteger(v) ? String(v) : String(v).trim();
    }
    return String(v).trim();
  }

  /** Parse DD/MM/YYYY (or -/.) and Excel serials → UTC Date (no TZ offset). */
  private parseDate(raw: any): Date | null {
    if (raw == null || raw === '') return null;
    if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
    if (typeof raw === 'number') {
      // Excel serial → JS Date (day 0 = 1899-12-30, accounts for the 1900 bug).
      const ms = Date.UTC(1899, 11, 30) + Math.round(raw) * 86400000;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    const s = String(raw).trim();
    const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      let year = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const d = new Date(Date.UTC(year, month - 1, day));
      return isNaN(d.getTime()) ? null : d;
    }
    const fallback = new Date(s);
    return isNaN(fallback.getTime()) ? null : fallback;
  }
}

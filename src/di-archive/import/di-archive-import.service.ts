import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import { DiArchiveService } from '../di-archive.service';

/**
 * Bulk MIGRATION import of historical DIs into `DiArchive` — a SEPARATE clone of
 * the operational `DiImportService`. The `Di` entity + its import are untouched.
 *
 * Columns (header detected BY LABEL, any row):
 *   Désignation → title (REQUIRED) | Description → description
 *   N° Série    → numSerie          | Rangement   → arrangement
 *   Statut      → statutHistorique (via STATUT_MAPPING — OPTIONAL column)
 *   N° DI       → refOrigine (idempotence key, OPTIONAL column)
 *   Client      → clientNom (string, OPTIONAL column)
 *
 * Two dimensions kept DISTINCT: `statutCompletude` (always starts INCOMPLET,
 * documents empty) vs `statutHistorique` (the final business status from the
 * file). Every row is stamped `origin=MIGRATION` + a per-run `importBatchId`.
 *
 * Side-effect-free: depends ONLY on `DiArchiveService` (no Discord / Stat /
 * Sheets / cron) → a mass import triggers NONE of the Phase-1 effects.
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
  archives: number;
  ignorees: number;
  importBatchId?: string;
}
export type LigneStatut = 'valide' | 'avertissement' | 'erreur';
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
  lignes: ImportLigne[];
  enTeteInvalide?: boolean;
  crees?: ImportCrees;
}

type ColKey =
  | 'title'
  | 'description'
  | 'numSerie'
  | 'arrangement'
  | 'statut'
  | 'refOrigine'
  | 'clientNom'
  | 'bcRef'
  | 'blRef'
  | 'devisRef'
  | 'factureRef'
  | 'validClient';

const MANDATORY_COLS: ColKey[] = ['title'];

const COL_ALIASES: Record<ColKey, string[]> = {
  title: ['designation', 'desgination', 'libelle', 'intitule', 'denomination', 'titre', 'title'],
  description: ['description', 'desc', 'descriptif', 'commentaire'],
  numSerie: ['n serie', 'no serie', 'numero serie', 'num serie', 'nserie', 'serie', 'numero de serie', 's n', 'sn'],
  arrangement: ['rangement', 'emplacement', 'localisation', 'location', 'arrangement', 'position'],
  statut: ['statut', 'status', 'etat', 'statut historique', 'statut metier', 'statut final'],
  refOrigine: ['n di', 'no di', 'numero di', 'num di', 'ndi', 'n di t', 'reference', 'ref', 'ref origine', 'reference origine'],
  clientNom: ['client', 'clients', 'nom client', 'societe', 'societe client', 'raison sociale'],
  // Document reference columns of the registry.
  bcRef: ['bc', 'b c', 'bon de commande', 'bon commande'],
  blRef: ['bl', 'b l', 'bon de livraison', 'bon livraison'],
  devisRef: ['devis'],
  factureRef: ['facture', 'factures'],
  validClient: ['valid client', 'validation client', 'valid clt', 'validclient'],
};

export const TEMPLATE_HEADERS = [
  'N° DI',
  'Désignation',
  'Description',
  'N° Série',
  'Client',
  'Statut',
  'Devis',
  'BC',
  'BL',
  'Valid. Client',
  'Facture',
  'Rangement',
];

interface ParsedRow {
  ligne: number;
  title: string;
  description: string;
  numSerie: string;
  arrangement: string;
  statutRaw: string;
  refOrigine: string;
  clientNom: string;
  bcRef: string;
  blRef: string;
  devisRef: string;
  factureRef: string;
  validClient: string;
  statutHistorique?: string | null; // free-text status captured during validation
  raw: Record<string, string>;
}

@Injectable()
export class DiArchiveImportService {
  private readonly logger = new Logger(DiArchiveImportService.name);

  constructor(private readonly diArchiveService: DiArchiveService) {}

  async run(buffer: Buffer, opts: { dryRun: boolean }): Promise<ImportReport> {
    const parsed = this.parse(buffer);
    if (parsed.enTeteInvalide) return parsed.report;

    const existingRefs = await this.diArchiveService.existingMigrationRefs();
    const { report, toCreate } = this.validate(parsed.rows, {
      hasStatut: parsed.hasStatut,
      existingRefs,
    });
    report.ligneEnTete = parsed.headerLine;
    if (opts.dryRun) return report;

    report.crees = await this.persist(toCreate, report);
    return report;
  }

  /** Downloadable .xlsx model (headers + one example row). */
  buildTemplate(): Buffer {
    const rows = [
      TEMPLATE_HEADERS,
      // N°DI, Désignation, Description, N°Série, Client, Statut, Devis, BC, BL, Valid.Client, Facture, Rangement
      ['T1394', 'AGRO NADHOUR', 'Carte four', '4821810100', 'COGEMHY', 'Livré', '072/24', 'BC-18', '', 'OK', '', 'A28'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = TEMPLATE_HEADERS.map(() => ({ wch: 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Archive');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  // ── Parsing (header by label; real 1-based Excel line numbers) ──

  private parse(buffer: Buffer): {
    rows: ParsedRow[];
    headerLine: number | null;
    hasStatut: boolean;
    enTeteInvalide: boolean;
    report: ImportReport;
  } {
    const empty = (msg: string): any => ({
      rows: [],
      headerLine: null,
      hasStatut: false,
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
      const cl = (sheet as any)[XLSX.utils.encode_cell({ r, c })];
      return cl ? cl.v : null;
    };

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
      return empty('En-tête introuvable : colonne obligatoire manquante (Désignation).');
    }

    const rows: ParsedRow[] = [];
    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const get = (k: ColKey): any =>
        cols[k] != null ? cell(r, cols[k] as number) : null;
      const title = this.str(get('title'));
      const description = this.str(get('description'));
      const numSerie = this.str(get('numSerie'));
      const arrangement = this.str(get('arrangement'));
      const statutRaw = this.str(get('statut'));
      const refOrigine = this.str(get('refOrigine'));
      const clientNom = this.str(get('clientNom'));
      const bcRef = this.str(get('bcRef'));
      const blRef = this.str(get('blRef'));
      const devisRef = this.str(get('devisRef'));
      const factureRef = this.str(get('factureRef'));
      const validClient = this.str(get('validClient'));

      if (
        !title && !description && !numSerie && !arrangement && !statutRaw &&
        !refOrigine && !clientNom && !bcRef && !blRef && !devisRef &&
        !factureRef && !validClient
      ) {
        continue; // blank row
      }

      rows.push({
        ligne: r + 1,
        title,
        description,
        numSerie,
        arrangement,
        statutRaw,
        refOrigine,
        clientNom,
        bcRef,
        blRef,
        devisRef,
        factureRef,
        validClient,
        raw: {
          'N° DI': refOrigine,
          Désignation: title,
          Description: description,
          'N° Série': numSerie,
          Client: clientNom,
          Statut: statutRaw,
          Devis: devisRef,
          BC: bcRef,
          BL: blRef,
          'Valid. Client': validClient,
          Facture: factureRef,
          Rangement: arrangement,
        },
      });
    }

    return {
      rows,
      headerLine: headerRow + 1,
      hasStatut: cols.statut != null,
      enTeteInvalide: false,
      report: null as any,
    };
  }

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

  // ── Validation (title required; status mapped when the column is present;
  //    idempotence skip on an already-migrated refOrigine) ──

  private validate(
    rows: ParsedRow[],
    ctx: { hasStatut: boolean; existingRefs: Set<string> },
  ): { report: ImportReport; toCreate: ParsedRow[] } {
    // Intra-file duplicate refOrigine.
    const seen = new Map<string, number>();
    for (const row of rows) {
      if (row.refOrigine) seen.set(row.refOrigine, (seen.get(row.refOrigine) ?? 0) + 1);
    }

    const warnings: ImportWarning[] = [];
    const erreurs: ImportError[] = [];
    const lignes: ImportLigne[] = [];
    const toCreate: ParsedRow[] = [];
    let valides = 0;

    for (const row of rows) {
      const motifs: string[] = [];

      if (!row.title) motifs.push('Désignation manquante');

      // Statut historique — TEXTE LIBRE : repris verbatim du fichier (Livré,
      // En cours, Att. BC…). Aucun rejet ; colonne/valeur vide → null.
      const statut: string | null = row.statutRaw ? row.statutRaw : null;

      if (row.refOrigine && (seen.get(row.refOrigine) ?? 0) > 1) {
        motifs.push(`N° DI « ${row.refOrigine} » en doublon dans le fichier`);
      }

      if (motifs.length) {
        erreurs.push({ ligne: row.ligne, valeurs: row.raw, motifs });
        lignes.push({ ligne: row.ligne, statut: 'erreur', valeurs: row.raw, motifs });
        continue;
      }

      // Idempotence — a refOrigine already migrated is SKIPPED (not overwritten).
      if (row.refOrigine && ctx.existingRefs.has(row.refOrigine)) {
        const message = `N° DI « ${row.refOrigine} » déjà importé — ignoré (idempotence)`;
        warnings.push({ ligne: row.ligne, message });
        lignes.push({ ligne: row.ligne, statut: 'avertissement', valeurs: row.raw, motifs: [message] });
        continue;
      }

      valides++;
      row.statutHistorique = statut;
      toCreate.push(row);
      lignes.push({ ligne: row.ligne, statut: 'valide', valeurs: row.raw, motifs: [] });
    }

    return {
      report: {
        ligneEnTete: null,
        total: rows.length,
        valides,
        warnings,
        erreurs,
        lignes,
      },
      toCreate,
    };
  }

  // ── Persistence — DiArchive ONLY, stamped MIGRATION + one batch id per run ──

  private async persist(toCreate: ParsedRow[], report: ImportReport): Promise<ImportCrees> {
    const importBatchId = uuidv4();
    let archives = 0;

    for (const row of toCreate) {
      try {
        await this.diArchiveService.createFromMigration(
          {
            title: row.title,
            description: row.description || undefined,
            numSerie: row.numSerie || undefined,
            arrangement: row.arrangement || undefined,
            clientNom: row.clientNom || null,
            refOrigine: row.refOrigine || null,
            statutHistorique: row.statutHistorique ?? null,
            // Text refs from the registry → drive completude (present cells) +
            // mark which docs still need an upload (empty cells).
            bcRef: row.bcRef || null,
            blRef: row.blRef || null,
            devisRef: row.devisRef || null,
            factureRef: row.factureRef || null,
            validClient: row.validClient || null,
          },
          { batchId: importBatchId },
        );
        archives++;
      } catch (err) {
        // Dup-key (idempotence race) or any failure → report, keep going.
        this.logger.error(
          `Archive migration row ${row.ligne} (${row.refOrigine || row.title}) failed: ${
            (err as Error)?.message ?? err
          }`,
        );
        report.erreurs.push({
          ligne: row.ligne,
          valeurs: row.raw,
          motifs: [`Échec de création : ${(err as Error)?.message ?? err}`],
        });
        report.valides = Math.max(0, report.valides - 1);
      }
    }

    return { archives, ignorees: report.total - archives, importBatchId };
  }

  // ── Primitives (local copies — the Di importer stays untouched) ──

  private norm(s: any): string {
    return String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  private str(v: any): string {
    if (v == null) return '';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v).trim();
    return String(v).trim();
  }
}

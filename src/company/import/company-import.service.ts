import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { CompanysService } from '../company.service';
import {
  COMPANY_COLUMNS,
  CompanyColumn,
  EXPORT_HEADERS,
  EMAIL_RE,
  PHONE_RE,
  companyToRow,
  cleanCell,
  normHeader,
} from './company-io';

/**
 * Export / import xlsx des sociétés — MÊME schéma canonique dans les deux sens
 * (voir company-io). Import en 2 temps : `dryRun` = APERÇU (aucune écriture) →
 * l'utilisateur confirme → écriture réelle. Rapport PAR LIGNE (jamais d'échec
 * global sur une mauvaise ligne). Upsert : MF si présent+trouvé, sinon Raison
 * sociale (insensible casse), sinon création.
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
export type LigneStatut = 'valide' | 'avertissement' | 'erreur';
export type LigneAction = 'create' | 'update' | null;
export interface ImportLigne {
  ligne: number;
  statut: LigneStatut;
  action: LigneAction;
  valeurs: Record<string, string>;
  motifs: string[];
}
export interface ImportReport {
  ligneEnTete: number | null;
  total: number;
  valides: number;
  aCreer: number;
  aMettreAJour: number;
  warnings: ImportWarning[];
  erreurs: ImportError[];
  lignes: ImportLigne[];
  enTeteInvalide?: boolean;
  crees?: { crees: number; majs: number; erreurs: number };
}

interface PreparedRow {
  ligne: number;
  doc: Record<string, any>; // document société à écrire
  raisonSociale: string;
  mf: string;
  action: LigneAction;
  matchId: string | null;
  raw: Record<string, string>;
}

function setPath(obj: any, path: string[], value: any): void {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    o[path[i]] = o[path[i]] ?? {};
    o = o[path[i]];
  }
  o[path[path.length - 1]] = value;
}

@Injectable()
export class CompanyImportService {
  private readonly logger = new Logger(CompanyImportService.name);

  constructor(private readonly companyService: CompanysService) {}

  // ── EXPORT ──────────────────────────────────────────────────────────────

  private buildWorkbook(companies: any[], sheet = 'Sociétés'): Buffer {
    const aoa = [EXPORT_HEADERS, ...companies.map((c) => companyToRow(c))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = EXPORT_HEADERS.map((h) => ({ wch: Math.max(12, h.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  /** Toutes les sociétés (tous champs) → .xlsx. Sert aussi de modèle d'import. */
  async exportAll(): Promise<Buffer> {
    const companies = await this.companyService.exportAllCompanies();
    return this.buildWorkbook(companies);
  }

  /** Une seule société → .xlsx (même schéma). */
  async exportOne(id: string): Promise<Buffer | null> {
    const company = await this.companyService.findOneCompany(id).catch(() => null);
    if (!company) return null;
    return this.buildWorkbook([company]);
  }

  /** Modèle vierge (en-têtes + une ligne d'exemple). */
  buildTemplate(): Buffer {
    const example: any = {
      name: 'ACME',
      raisonSociale: 'ACME SARL',
      region: 'Tunis',
      address: '12 rue de Carthage',
      email: 'contact@acme.tn',
      phone: '+216 71 000 000',
      fax: '+216 71 000 001',
      webSiteLink: 'https://acme.tn',
      mf: '1234567/A/M/000',
      rne: 'B0123456',
      Exoneration: 'Non',
      activitePrincipale: 'Distribution',
      activiteSecondaire: 'Maintenance',
      serviceAchat: { name: 'A. Achat', email: 'achat@acme.tn', phone: '+216 71 000 010' },
      serviceTechnique: { name: 'T. Tech', email: 'tech@acme.tn', phone: '+216 71 000 020' },
      serviceFinancier: { name: 'F. Fin', email: 'fin@acme.tn', phone: '+216 71 000 030' },
    };
    return this.buildWorkbook([example], 'Modèle');
  }

  // ── IMPORT ──────────────────────────────────────────────────────────────

  async run(buffer: Buffer, opts: { dryRun: boolean }): Promise<ImportReport> {
    const parsed = this.parse(buffer);
    if (parsed.enTeteInvalide) return parsed.report;

    const index = await this.companyService.loadImportMatchIndex();
    const byMf = new Map<string, string>();
    const byRs = new Map<string, string>();
    for (const c of index) {
      if (c.mf && c.mf.trim()) byMf.set(c.mf.trim(), c._id);
      if (c.raisonSociale && c.raisonSociale.trim())
        byRs.set(c.raisonSociale.trim().toLowerCase(), c._id);
    }

    const report = this.validate(parsed.rows, byMf, byRs);
    report.ligneEnTete = parsed.headerLine;
    if (opts.dryRun) return report;

    await this.persist(parsed.rows, report);
    return report;
  }

  // ── Parsing (en-tête par label ; n° de ligne Excel réels 1-based) ──

  private parse(buffer: Buffer): {
    rows: PreparedRow[];
    headerLine: number | null;
    enTeteInvalide: boolean;
    report: ImportReport;
  } {
    const fail = (msg: string): any => ({
      rows: [],
      headerLine: null,
      enTeteInvalide: true,
      report: {
        ligneEnTete: null,
        total: 0,
        valides: 0,
        aCreer: 0,
        aMettreAJour: 0,
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
      return fail('Fichier illisible : .xlsx valide attendu.');
    }
    const sheet = wb.SheetNames[0] ? wb.Sheets[wb.SheetNames[0]] : undefined;
    if (!sheet || !sheet['!ref']) return fail('Feuille vide : aucune donnée détectée.');

    const range = XLSX.utils.decode_range(sheet['!ref']);
    const cell = (r: number, c: number): any => {
      const cl = (sheet as any)[XLSX.utils.encode_cell({ r, c })];
      return cl ? cl.v : null;
    };

    // En-tête = 1re ligne contenant AU MOINS « Raison sociale ».
    const wantedByHeader = new Map<string, CompanyColumn>();
    for (const col of COMPANY_COLUMNS) wantedByHeader.set(normHeader(col.header), col);

    let headerRow = -1;
    const colIndex = new Map<CompanyColumn, number>();
    for (let r = range.s.r; r <= range.e.r; r++) {
      const found = new Map<CompanyColumn, number>();
      for (let c = range.s.c; c <= range.e.c; c++) {
        const col = wantedByHeader.get(normHeader(cell(r, c)));
        if (col && !found.has(col)) found.set(col, c);
      }
      const rsCol = COMPANY_COLUMNS.find((x) => x.path[0] === 'raisonSociale')!;
      if (found.has(rsCol)) {
        headerRow = r;
        found.forEach((v, k) => colIndex.set(k, v));
        break;
      }
    }
    if (headerRow === -1) {
      return fail('En-tête introuvable : la colonne « Raison sociale » est requise.');
    }

    const rows: PreparedRow[] = [];
    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const doc: Record<string, any> = {};
      const raw: Record<string, string> = {};
      let anyValue = false;

      for (const col of COMPANY_COLUMNS) {
        const c = colIndex.get(col);
        let val = c != null ? cleanCell(cell(r, c)) : '';
        if (col.kind === 'exon') val = this.normExon(val);
        raw[col.header] = val;
        if (val) anyValue = true;
        setPath(doc, col.path, val);
      }
      if (!anyValue) continue; // ligne vide

      rows.push({
        ligne: r + 1,
        doc,
        raisonSociale: (doc.raisonSociale ?? '').toString(),
        mf: (doc.mf ?? '').toString(),
        action: null,
        matchId: null,
        raw,
      });
    }

    return { rows, headerLine: headerRow + 1, enTeteInvalide: false, report: null as any };
  }

  // ── Validation + résolution upsert (sans écrire) ──

  private validate(
    rows: PreparedRow[],
    byMf: Map<string, string>,
    byRs: Map<string, string>,
  ): ImportReport {
    const warnings: ImportWarning[] = [];
    const erreurs: ImportError[] = [];
    const lignes: ImportLigne[] = [];
    let valides = 0;
    let aCreer = 0;
    let aMettreAJour = 0;
    const seenKeys = new Set<string>(); // doublons INTRA-fichier

    for (const row of rows) {
      const motifs: string[] = [];
      const rowWarnings: string[] = [];

      if (!row.raisonSociale.trim()) motifs.push('Raison sociale manquante (obligatoire)');

      // Formats (non bloquants → avertissements).
      for (const col of COMPANY_COLUMNS) {
        const v = row.raw[col.header];
        if (!v) continue;
        if (col.kind === 'email' && !EMAIL_RE.test(v))
          rowWarnings.push(`${col.header} : e-mail au format douteux`);
        if (col.kind === 'phone' && !PHONE_RE.test(v))
          rowWarnings.push(`${col.header} : téléphone au format douteux`);
        if (col.kind === 'exon' && v !== 'Oui' && v !== 'Non')
          rowWarnings.push(`Exonération : « Oui »/« Non » attendu`);
      }

      // Doublon intra-fichier sur la clé d'upsert.
      const key = row.mf.trim()
        ? 'mf:' + row.mf.trim()
        : 'rs:' + row.raisonSociale.trim().toLowerCase();
      if (row.raisonSociale.trim() && seenKeys.has(key)) {
        motifs.push('Doublon dans le fichier (même MF ou Raison sociale)');
      }

      if (motifs.length) {
        erreurs.push({ ligne: row.ligne, valeurs: row.raw, motifs });
        lignes.push({ ligne: row.ligne, statut: 'erreur', action: null, valeurs: row.raw, motifs });
        continue;
      }
      seenKeys.add(key);

      // Résolution upsert : MF d'abord, puis Raison sociale (ci).
      let matchId: string | null = null;
      if (row.mf.trim() && byMf.has(row.mf.trim())) matchId = byMf.get(row.mf.trim())!;
      else if (byRs.has(row.raisonSociale.trim().toLowerCase()))
        matchId = byRs.get(row.raisonSociale.trim().toLowerCase())!;

      row.action = matchId ? 'update' : 'create';
      row.matchId = matchId;
      if (matchId) aMettreAJour++;
      else aCreer++;
      valides++;

      for (const w of rowWarnings) warnings.push({ ligne: row.ligne, message: w });
      lignes.push({
        ligne: row.ligne,
        statut: rowWarnings.length ? 'avertissement' : 'valide',
        action: row.action,
        valeurs: row.raw,
        motifs: rowWarnings,
      });
    }

    return {
      ligneEnTete: null,
      total: rows.length,
      valides,
      aCreer,
      aMettreAJour,
      warnings,
      erreurs,
      lignes,
    };
  }

  // ── Écriture (upsert), par ligne, tolérante aux échecs ──

  private async persist(rows: PreparedRow[], report: ImportReport): Promise<void> {
    let crees = 0;
    let majs = 0;
    let echecs = 0;

    for (const row of rows) {
      if (row.action == null) continue; // ligne en erreur
      try {
        if (row.action === 'update' && row.matchId) {
          await this.companyService.updateFromImport(row.matchId, row.doc);
          majs++;
        } else {
          await this.companyService.createFromImport(row.doc);
          crees++;
        }
      } catch (err) {
        echecs++;
        report.valides = Math.max(0, report.valides - 1);
        const motif = `Échec d'écriture : ${(err as Error)?.message ?? err}`;
        report.erreurs.push({ ligne: row.ligne, valeurs: row.raw, motifs: [motif] });
        this.logger.error(`Import société ligne ${row.ligne} échouée : ${motif}`);
      }
    }

    report.crees = { crees, majs, erreurs: echecs };
  }

  private normExon(v: string): string {
    const t = v.trim().toLowerCase();
    if (t === 'oui') return 'Oui';
    if (t === 'non') return 'Non';
    return v.trim() === '' ? '' : v.trim(); // valeur douteuse gardée → avertissement en validation
  }
}

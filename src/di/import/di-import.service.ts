import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as XLSX from 'xlsx';
import { DiService } from '../di.service';
import { ClientsService } from 'src/clients/clients.service';
import { LocationService } from 'src/location/location.service';
import { NotificationsGateway } from 'src/notification.gateway';
import { DiImportJobService } from './di-import-job.service';
import { TierAliasService } from './tier-alias.service';
import {
  normalizeTierName,
  isValidDecisionKind,
} from './tier-name.util';

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
  /** DI dont la référence appartenait à une DI SUPPRIMÉE (soft-delete) : le
   *  vestige a été purgé et la DI recréée lors du ré-import. Sous-ensemble de
   *  `dis` (comptées aussi dans `dis`). */
  reactivees?: number;
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
  // Colonne TIERS (personne Client OU Société) — le TYPE n'est plus déduit du
  // libellé de colonne mais résolu par `matchTier` (nom rapproché des Clients ET
  // des Sociétés existants). Les libellés à consonance « société » ne forcent
  // donc plus un Client : ils identifient seulement la colonne du tiers.
  client: ['client', 'clients', 'nom client', 'tiers', 'societe client', 'raison sociale'],
  date: ['date de reception', 'date reception', 'date recue', 'date recu', 'reception', 'date'],
  rangement: ['rangement', 'emplacement', 'localisation', 'location', 'position'],
};

// Human labels reused for the template + error reporting.
export const TEMPLATE_HEADERS = [
  'N° DI',
  'Désignation',
  'N° Série',
  'Client / Société',
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
    @InjectModel('Company') private readonly companyModel: Model<any>,
    @InjectModel('Location') private readonly locationModel: Model<any>,
    private readonly diService: DiService,
    private readonly clientsService: ClientsService,
    private readonly locationService: LocationService,
    private readonly jobService: DiImportJobService,
    private readonly notificationGateway: NotificationsGateway,
    private readonly aliasService: TierAliasService,
  ) {}

  /** Taille de lot pour l'exécution par job (25–50). Un `yield` entre les lots
   *  laisse respirer l'event loop ; le volume d'import (centaines) reste rapide. */
  private static readonly BATCH_SIZE = 25;

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
    // Contexte de résolution (caches + ids + alias) chargé UNE fois, partagé
    // entre la vérification (lecture seule) et la persistance → le dry-run
    // reflète EXACTEMENT ce que fera l'import réel (même résolution, alias inclus).
    const resCtx = await this.loadResolutionContext();

    const report = this.validate(parsed.rows, existing, resCtx);
    report.ligneEnTete = parsed.headerLine;

    if (opts.dryRun) return report;

    // Real import — persist only the rows flagged valid by `validate`.
    const crees = await this.persist(parsed.rows, report, {
      ...resCtx,
      createdBy: opts.createdBy,
      deletedRefs: existing.deletedRefs,
    });
    report.crees = crees;
    return report;
  }

  // ---------------------------------------------------------------------------
  // Exécution en JOB (phase non interactive, par lots + progression WebSocket)
  // ---------------------------------------------------------------------------

  /**
   * Démarre l'exécution d'un import en JOB SERVEUR (fire-and-forget) : parse +
   * valide (100 % non destructif), crée le job `di_import_jobs`, puis lance le
   * traitement par lots EN ARRIÈRE-PLAN (promesse NON attendue → l'exécution
   * survit à la fermeture de l'onglet) et renvoie immédiatement `{ jobId, total }`.
   * Le suivi passe par les événements WS `di-import.progress` (portant `jobId`)
   * et par l'état persisté du job (consultable après réouverture).
   */
  async executeAsJob(
    buffer: Buffer,
    opts: {
      createdBy?: string;
      /** Résolutions d'ambiguïté « both » tranchées par l'utilisateur à l'écran
       *  de vérification (par n° de ligne). PAS de mémoire inter-imports ici
       *  (tier_aliases = étape ultérieure) — décision valable pour CE lot. */
      decisions?: Array<{ ligne: number; kind: 'client' | 'company' }>;
    },
  ): Promise<{ jobId?: string; total: number; report?: ImportReport }> {
    const parsed = this.parse(buffer);
    if (parsed.enTeteInvalide) return { total: 0, report: parsed.report };

    const decisions = new Map<number, 'client' | 'company'>(
      (opts.decisions ?? []).map((d) => [d.ligne, d.kind]),
    );

    const existing = await this.loadExistingRefs();
    const resCtx = await this.loadResolutionContext();
    const report = this.validate(parsed.rows, existing, resCtx, decisions);
    report.ligneEnTete = parsed.headerLine;

    // Seules les lignes VALIDES (non erreur) sont exécutées.
    const errorLines = new Set(report.erreurs.map((e) => e.ligne));
    const toImport = parsed.rows.filter((r) => !errorLines.has(r.ligne));

    const job = await this.jobService.create({
      createdBy: opts.createdBy,
      total: toImport.length,
    });

    // Fire-and-forget : le traitement vit côté serveur, indépendant du client.
    // `processJob` gère lui-même son échec (→ FAILED) ; le `.catch` est un
    // dernier filet si même la mise à jour d'échec venait à rejeter.
    this.processJob(job.jobId, toImport, {
      ...resCtx,
      createdBy: opts.createdBy,
      decisions,
      deletedRefs: existing.deletedRefs,
    }).catch((err) =>
      this.logger.error(
        `processJob ${job.jobId} a rejeté hors gestion: ${(err as Error)?.message ?? err}`,
      ),
    );

    return { jobId: job.jobId, total: toImport.length };
  }

  /**
   * Traitement PAR LOTS d'un job d'import :
   *   - `markRunning` puis lots de `BATCH_SIZE` lignes ;
   *   - par ligne : résolution tiers (Société/Client, cf. `matchTier`) + création
   *     via `DiService.createDi` (référence forcée du fichier → l'index unique +
   *     `bumpDiRefTo` restent la garantie d'intégrité) ;
   *   - IDEMPOTENT : une référence déjà en base (E11000) est IGNORÉE, jamais
   *     recréée ni comptée en erreur → un ré-lancement du même lot ne duplique pas ;
   *   - après chaque lot : `incrementProgress` (atomique) + événement WS + `yield` ;
   *   - fin : `COMPLETED` + rapport stocké. Erreur FATALE (infra) : `FAILED`, erreur
   *     stockée, les lignes déjà créées RESTENT (aucune suppression).
   */
  private async processJob(
    jobId: string,
    rows: ParsedRow[],
    ctx: {
      clientCache: Map<string, string>;
      companyCache: Map<string, string>;
      clientIds?: Set<string>;
      companyIds?: Set<string>;
      aliasMap?: Map<string, any>;
      createdBy?: string;
      decisions?: Map<number, 'client' | 'company'>;
      /** Références portées par des DI SUPPRIMÉES (soft-delete) → à purger avant
       *  recréation pour libérer l'index unique `_idnum` (ré-import après
       *  suppression). Voir `loadExistingRefs`. */
      deletedRefs?: Set<string>;
    },
    report?: ImportReport,
  ): Promise<void> {
    const rep: ImportReport =
      report ??
      ({ ligneEnTete: null, total: rows.length, valides: rows.length, warnings: [], erreurs: [], lignes: [] } as ImportReport);
    const total = rows.length;
    let dis = 0;
    let clientsCreated = 0;
    let locationsCreated = 0;
    let ignorees = 0;
    let reactivees = 0;
    let processed = 0; // lignes traitées (suivi ligne par ligne, affichage live)

    try {
      await this.jobService.markRunning(jobId);
      const locationCache = await this.buildLocationCache();
      this.emitProgress(jobId, 0, total, null, 'RUNNING');

      for (let i = 0; i < rows.length; i += DiImportService.BATCH_SIZE) {
        const batch = rows.slice(i, i + DiImportService.BATCH_SIZE);
        let lastRef: string | null = null;

        for (const row of batch) {
          lastRef = row.nDi;
          // Suivi ligne par ligne — étape « rattachement du client ».
          this.emitProgress(
            jobId,
            processed,
            total,
            row.nDi,
            'RUNNING',
            `Ligne ${row.ligne} · ${row.nDi} — rattachement du client${
              row.clientName ? ` « ${row.clientName} »` : ''
            }…`,
          );
          try {
            const tier = this.resolveTier(row.clientName, ctx);
            let clientId: string | undefined;
            let companyId: string | undefined;
            if (tier.kind === 'both') {
              // Résolu par la décision utilisateur (l'écran de vérification l'a
              // exigée ; les non tranchées ont été exclues au validate). Le
              // `tierId` mémorisé est BACKEND (jamais fourni par le front).
              const decided = ctx.decisions?.get(row.ligne);
              if (decided === 'company') {
                companyId = tier.companyId;
                await this.rememberDecision(
                  row.clientName,
                  tier.companyId,
                  'SOCIETE',
                  ctx.createdBy,
                );
              } else if (decided === 'client') {
                clientId = tier.clientId;
                await this.rememberDecision(
                  row.clientName,
                  tier.clientId,
                  'CLIENT',
                  ctx.createdBy,
                );
              } else {
                // GARDE D'INVARIANT (défense en profondeur) : une ligne « both »
                // ne peut JAMAIS être créée sans rattachement. Normalement
                // écartée au validate (whitelist `kind`) ; si une décision
                // invalide atteignait tout de même ce point (payload forgé /
                // futur autre client), on lève → l'erreur est collectée par
                // ligne, AUCUNE DI n'est créée pour elle.
                throw new Error(
                  `Décision d'ambiguïté invalide pour « ${row.clientName} » : «kind» attendu « client » ou « company ».`,
                );
              }
            } else if (tier.kind === 'company') {
              companyId = tier.companyId;
            } else if (tier.kind === 'client') {
              clientId = tier.clientId;
            } else {
              const client = await this.resolveClient(
                row.clientName,
                ctx.clientCache,
              );
              clientId = client.id;
              if (client.created) clientsCreated++;
            }

            let locationId: string | undefined;
            if (row.rangement) {
              const loc = await this.resolveLocation(
                row.rangement,
                locationCache,
              );
              locationId = loc.id;
              if (loc.created) locationsCreated++;
            }

            // Ré-import après suppression : si la référence appartient à une DI
            // SUPPRIMÉE (soft-delete), on purge le vestige AVANT de recréer, pour
            // libérer l'index unique `_idnum`. Sans ça, `createDi` lèverait E11000
            // → la ligne serait « ignorée » et la DI ne réapparaîtrait jamais
            // (c'est le bug « existe déjà » malgré la suppression). Une DI ACTIVE
            // reste protégée (le filtre `isDeleted:true` de `freeDeletedRef`).
            const revived = ctx.deletedRefs?.has(row.nDi)
              ? await this.freeDeletedRef(row.nDi)
              : false;

            // Suivi ligne par ligne — étape « création de la DI ».
            this.emitProgress(
              jobId,
              processed,
              total,
              row.nDi,
              'RUNNING',
              `Ligne ${row.ligne} · ${row.nDi} — ${
                revived ? 'réactivation' : 'création'
              } de la DI « ${row.designation} »…`,
            );

            await this.diService.createDi(
              {
                title: row.designation,
                nSerie: row.nSerie,
                client_id: clientId,
                company_id: companyId,
                location_id: locationId,
                type_client: companyId ? 'Company' : 'Client',
                status: 'CREATED',
                dateReception: row.dateValue ?? undefined,
                createdBy: ctx.createdBy,
              } as any,
              { forcedRef: row.nDi, skipNotify: true },
            );
            dis++;
            if (revived) reactivees++;
          } catch (err) {
            if (this.isDuplicateKeyError(err)) {
              // Idempotence : la référence existe déjà → IGNORÉE (ni recréation,
              // ni erreur). Couvre le ré-lancement d'un lot / la reprise.
              ignorees++;
            } else {
              rep.erreurs.push({
                ligne: row.ligne,
                valeurs: row.raw,
                motifs: [
                  `Échec de création : ${(err as Error)?.message ?? err}`,
                ],
              });
            }
          }
          processed++;
        }

        const updated = await this.jobService.incrementProgress(
          jobId,
          batch.length,
          lastRef ?? undefined,
        );
        this.emitProgress(
          jobId,
          updated?.done ?? Math.min(i + batch.length, total),
          total,
          lastRef,
          'RUNNING',
        );
        await this.yieldToEventLoop();
      }

      rep.crees = {
        dis,
        clients: clientsCreated,
        locations: locationsCreated,
        ignorees,
        reactivees,
      };
      await this.jobService.complete(jobId, rep);
      this.emitProgress(jobId, total, total, null, 'COMPLETED');
    } catch (err) {
      // Erreur FATALE (infra) : job FAILED, erreur stockée, rapport PARTIEL
      // conservé — les DI déjà créées ne sont JAMAIS supprimées.
      rep.crees = {
        dis,
        clients: clientsCreated,
        locations: locationsCreated,
        ignorees,
        reactivees,
      };
      await this.jobService.fail(
        jobId,
        (err as Error)?.message ?? String(err),
        rep,
      );
      this.emitProgress(jobId, dis + ignorees, total, null, 'FAILED');
    }
  }

  /** Émission de progression — best-effort : un échec WS ne fait JAMAIS échouer
   *  le job (l'état fiable est en base). Le `jobId` est TOUJOURS présent. */
  private emitProgress(
    jobId: string,
    done: number,
    total: number,
    currentRef: string | null,
    phase: string,
    detail?: string,
  ): void {
    try {
      this.notificationGateway.diImportProgress({
        jobId,
        done,
        total,
        currentRef: currentRef ?? null,
        phase,
        detail,
      });
    } catch (err) {
      this.logger.warn(
        `WS di-import.progress échec (job ${jobId}): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /** Cède la main à l'event loop entre deux lots. */
  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /** Mémorise une décision d'ambiguïté en alias (best-effort : un échec
   *  d'enregistrement ne fait PAS échouer l'import de la ligne). `tierId` est
   *  BACKEND-dérivé ; `record` le revalide côté serveur de toute façon. */
  private async rememberDecision(
    importedName: string,
    tierId: string | undefined,
    type: 'CLIENT' | 'SOCIETE',
    decidedBy?: string,
  ): Promise<void> {
    if (!tierId) return;
    try {
      await this.aliasService.record({ importedName, tierId, type, decidedBy });
    } catch (err) {
      this.logger.warn(
        `Alias non mémorisé (${importedName}): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /** Détecte une violation d'unicité Mongo (index `_idnum`) → idempotence. */
  private isDuplicateKeyError(err: any): boolean {
    return (
      !!err &&
      (err.code === 11000 ||
        err.code === 11001 ||
        /E11000|duplicate key/i.test((err as Error)?.message ?? ''))
    );
  }

  /** Build the downloadable .xlsx model (headers + two example rows). */
  buildTemplate(): Buffer {
    // Exemples NEUTRES : un Client (personne) + une Société — le modèle ne doit
    // pas enseigner de tiers réels (les anciens COGEMHY/PERSO(PROMODAR) étaient
    // de vraies Sociétés → il apprenait le doublon Client↔Société).
    const rows = [
      TEMPLATE_HEADERS,
      ['T1394', 'AGRO NADHOUR', '***', 'DUPONT Jean', '18/06/2026', 'A28'],
      ['T1345', 'CARTE FOUR', '4821810100', 'EXEMPLE SARL', '04/05/2026', 'A15'],
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
    resCtx: {
      clientCache: Map<string, string>;
      companyCache: Map<string, string>;
      clientIds?: Set<string>;
      companyIds?: Set<string>;
      aliasMap?: Map<string, any>;
    },
    decisions?: Map<number, 'client' | 'company'>,
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

      // Résolution du tiers en LECTURE SEULE (Client ET Société existants) —
      // même logique qu'au persist. « des deux côtés » = collision non
      // automatisable → à trancher manuellement (bloquant tant que la refonte
      // interactive n'est pas là).
      const tier = row.clientName
        ? this.resolveTier(row.clientName, resCtx)
        : ({ kind: 'none' } as ReturnType<DiImportService['resolveTier']>);

      if (!row.nDi) motifs.push('N° DI manquant');
      if (!row.designation) motifs.push('Désignation manquante');
      if (!row.clientName) motifs.push('Client manquant');
      if (row.nDi && existing.refs.has(row.nDi)) {
        motifs.push(`N° DI « ${row.nDi} » déjà existant en base (non écrasé)`);
      }
      if (row.nDi && (seen.get(row.nDi) ?? 0) > 1) {
        motifs.push(`N° DI « ${row.nDi} » en doublon dans le fichier`);
      }
      // Ambiguïté « both » : bloquante SAUF si l'utilisateur l'a tranchée à
      // l'écran de vérification par une décision VALIDE. Le `kind` est filtré
      // par la whitelist stricte : une valeur absente OU non conforme
      // (« foo », « companyxxx », …) est traitée comme NON tranchée → la ligne
      // est rejetée (jamais importée sans rattachement).
      const rawDecided =
        tier.kind === 'both' ? decisions?.get(row.ligne) : undefined;
      const decidedTier = isValidDecisionKind(rawDecided)
        ? rawDecided
        : undefined;
      if (tier.kind === 'both' && !decidedTier) {
        motifs.push(
          `« ${row.clientName} » existe comme Client ET comme Société — à trancher (rattachement manuel requis)`,
        );
      }

      if (motifs.length > 0) {
        erreurs.push({ ligne: row.ligne, valeurs: row.raw, motifs });
        lignes.push({ ligne: row.ligne, statut: 'erreur', valeurs: row.raw, motifs });
        continue;
      }

      // Valid row → may still carry non-blocking warnings.
      valides++;
      const rowWarnings: string[] = [];
      // Aperçu de la résolution du tiers (informe l'utilisateur AVANT écriture).
      // Un alias appliqué est SIGNALÉ (jamais silencieux) avec l'auteur/la date.
      if (tier.viaAlias) {
        const who = tier.alias?.decidedBy ? ` — décision de ${tier.alias.decidedBy}` : '';
        rowWarnings.push(
          `Auto-résolu par alias → ${
            tier.kind === 'company' ? 'Société' : 'Client'
          } « ${row.clientName} »${who} (modifiable)`,
        );
      } else if (tier.kind === 'both' && decidedTier) {
        rowWarnings.push(
          `Ambiguïté résolue → rattaché ${
            decidedTier === 'company' ? 'à la Société' : 'au Client'
          } « ${row.clientName} »`,
        );
      } else if (tier.kind === 'company') {
        rowWarnings.push(
          `Rattaché à la Société existante « ${row.clientName} » (aucun Client créé)`,
        );
      } else if (tier.kind === 'none') {
        rowWarnings.push(
          `Tiers « ${row.clientName} » inconnu — un Client sera créé (fiche à compléter)`,
        );
      }
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
    ctx: {
      clientCache: Map<string, string>;
      companyCache: Map<string, string>;
      clientIds?: Set<string>;
      companyIds?: Set<string>;
      aliasMap?: Map<string, any>;
      createdBy?: string;
      /** Références de DI SUPPRIMÉES (soft-delete) à purger avant recréation. */
      deletedRefs?: Set<string>;
    },
  ): Promise<ImportCrees> {
    // Rows that errored during validation are excluded from the import set.
    const errorLines = new Set(report.erreurs.map((e) => e.ligne));
    const toImport = rows.filter((r) => !errorLines.has(r.ligne));

    const { clientCache, createdBy } = ctx;
    const locationCache = await this.buildLocationCache();
    let dis = 0;
    let clientsCreated = 0;
    let locationsCreated = 0;
    let reactivees = 0;

    for (const row of toImport) {
      try {
        // Résolution (alias inclus) : Société/Client existant ou aliasé →
        // rattacher ; inconnu → créer un Client. « both » est exclu (erreur).
        const tier = this.resolveTier(row.clientName, ctx);
        let clientId: string | undefined;
        let companyId: string | undefined;
        if (tier.kind === 'company') {
          companyId = tier.companyId;
        } else if (tier.kind === 'client') {
          clientId = tier.clientId;
        } else {
          const client = await this.resolveClient(row.clientName, clientCache);
          clientId = client.id;
          if (client.created) clientsCreated++;
        }

        let locationId: string | undefined;
        if (row.rangement) {
          const loc = await this.resolveLocation(row.rangement, locationCache);
          locationId = loc.id;
          if (loc.created) locationsCreated++;
        }

        // Ré-import après suppression : purge le vestige SOFT-DELETED portant
        // cette référence pour libérer l'index unique `_idnum` avant recréation
        // (sinon E11000). Une DI ACTIVE n'est jamais touchée.
        const revived = ctx.deletedRefs?.has(row.nDi)
          ? await this.freeDeletedRef(row.nDi)
          : false;

        const input: any = {
          title: row.designation,
          nSerie: row.nSerie,
          client_id: clientId,
          company_id: companyId,
          location_id: locationId,
          type_client: companyId ? 'Company' : 'Client',
          status: 'CREATED',
          dateReception: row.dateValue ?? undefined,
          createdBy,
        };
        await this.diService.createDi(input, {
          forcedRef: row.nDi,
          skipNotify: true,
        });
        dis++;
        if (revived) reactivees++;
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
      reactivees,
    };
  }

  // ---------------------------------------------------------------------------
  // Resolution helpers (idempotent within a single import)
  // ---------------------------------------------------------------------------

  private async loadExistingRefs(): Promise<{
    refs: Set<string>;
    deletedRefs: Set<string>;
    nextAuto: number;
  }> {
    // On lit AUSSI `isDeleted` : une DI SUPPRIMÉE (soft-delete) conserve son
    // `_idnum` (ligne + index unique). Elle ne doit PAS bloquer le ré-import de
    // cette référence — `refs` (rejet précheck) ne contient donc QUE les DI
    // ACTIVES ; les références supprimées vont dans `deletedRefs` (réactivables
    // au persist). Le compteur `max` reste calculé sur TOUTES les références
    // (actives + supprimées) pour éviter qu'une réf auto-générée entre en
    // collision avec l'index d'une DI supprimée.
    const docs = await this.diModel
      .find({}, { _idnum: 1, isDeleted: 1 })
      .lean();
    const refs = new Set<string>();
    const deletedRefs = new Set<string>();
    let max = 0;
    for (const d of docs) {
      const ref = this.str((d as any)?._idnum);
      if (ref) {
        if ((d as any)?.isDeleted === true) deletedRefs.add(ref);
        else refs.add(ref);
      }
      const m = ref.match(/^(?:DI|T)(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return { refs, deletedRefs, nextAuto: max + 1 };
  }

  /** Purge la DI SOFT-DELETED portant `ref` (si elle existe) pour libérer
   *  l'index unique `_idnum` avant un ré-import. Le filtre `isDeleted: true`
   *  garantit qu'une DI ACTIVE n'est JAMAIS touchée (idempotence préservée :
   *  une référence active reste bloquée). Retourne true si une purge a eu lieu. */
  private async freeDeletedRef(ref: string): Promise<boolean> {
    if (!ref) return false;
    const res = await this.diModel.deleteOne({ _idnum: ref, isDeleted: true });
    return (res?.deletedCount ?? 0) > 0;
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

  /** Cache Sociétés par nom normalisé (name + raisonSociale). Lecture seule. */
  private async buildCompanyCache(): Promise<Map<string, string>> {
    const docs = await this.companyModel
      .find({ isDeleted: { $ne: true } }, { _id: 1, name: 1, raisonSociale: 1 })
      .lean();
    const map = new Map<string, string>();
    for (const c of docs) {
      for (const label of [(c as any).name, (c as any).raisonSociale]) {
        const key = this.norm(label);
        if (key && !map.has(key)) map.set(key, (c as any)._id);
      }
    }
    return map;
  }

  /** Résout un nom de tiers en LECTURE SEULE contre Sociétés ET Clients
   *  existants (ne crée rien). `both` = présent des DEUX côtés → collision à
   *  trancher (jamais d'automatisme). Sert au dry-run ET au persist (cohérence). */
  private matchTier(
    name: string,
    clientCache: Map<string, string>,
    companyCache: Map<string, string>,
  ): {
    kind: 'company' | 'client' | 'both' | 'none';
    companyId?: string;
    clientId?: string;
  } {
    const key = this.norm(name);
    const companyId = key ? companyCache.get(key) : undefined;
    const clientId = key ? clientCache.get(key) : undefined;
    if (companyId && clientId) return { kind: 'both', companyId, clientId };
    if (companyId) return { kind: 'company', companyId };
    if (clientId) return { kind: 'client', clientId };
    return { kind: 'none' };
  }

  /** Contexte de résolution chargé UNE fois par import (caches nom→id, ensembles
   *  d'ids pour valider les alias, et la map des alias). Partagé dry-run ↔
   *  exécution → résolution IDENTIQUE. */
  private async loadResolutionContext(): Promise<{
    clientCache: Map<string, string>;
    companyCache: Map<string, string>;
    clientIds: Set<string>;
    companyIds: Set<string>;
    aliasMap: Map<string, any>;
  }> {
    const [clients, companies, aliasMap] = await Promise.all([
      this.clientModel
        .find({ isDeleted: { $ne: true } }, { _id: 1, first_name: 1, last_name: 1 })
        .lean(),
      this.companyModel
        .find({ isDeleted: { $ne: true } }, { _id: 1, name: 1, raisonSociale: 1 })
        .lean(),
      this.aliasService.getAliasMap(),
    ]);
    const clientCache = new Map<string, string>();
    const clientIds = new Set<string>();
    for (const c of clients as any[]) {
      clientIds.add(c._id);
      const key = this.norm(`${c.first_name ?? ''} ${c.last_name ?? ''}`);
      if (key && !clientCache.has(key)) clientCache.set(key, c._id);
    }
    const companyCache = new Map<string, string>();
    const companyIds = new Set<string>();
    for (const c of companies as any[]) {
      companyIds.add(c._id);
      for (const label of [c.name, c.raisonSociale]) {
        const key = this.norm(label);
        if (key && !companyCache.has(key)) companyCache.set(key, c._id);
      }
    }
    return { clientCache, companyCache, clientIds, companyIds, aliasMap };
  }

  /**
   * Résolution FINALE d'un tiers = `matchTier` + application éventuelle d'un
   * ALIAS. Sécurité : si la situation courante est AMBIGUË (« both »), l'alias
   * n'est JAMAIS appliqué (on redemande). Sinon un alias COHÉRENT (`isValid` :
   * tiers présent + bon type) prime et pointe le tiers précis (résout aussi les
   * variantes de nom / homonymes). Un alias incohérent est ignoré.
   */
  private resolveTier(
    name: string,
    ctx: {
      clientCache: Map<string, string>;
      companyCache: Map<string, string>;
      clientIds?: Set<string>;
      companyIds?: Set<string>;
      aliasMap?: Map<string, any>;
    },
  ): {
    kind: 'company' | 'client' | 'both' | 'none';
    companyId?: string;
    clientId?: string;
    viaAlias?: boolean;
    alias?: any;
  } {
    const base = this.matchTier(name, ctx.clientCache, ctx.companyCache);
    if (base.kind === 'both') return base; // ambigu → alias NON appliqué
    const alias = ctx.aliasMap?.get(this.norm(name));
    if (
      alias &&
      this.aliasService.isValid(
        alias,
        ctx.clientIds ?? new Set(),
        ctx.companyIds ?? new Set(),
      )
    ) {
      return alias.type === 'SOCIETE'
        ? { kind: 'company', companyId: alias.tierId, viaAlias: true, alias }
        : { kind: 'client', clientId: alias.tierId, viaAlias: true, alias };
    }
    return base;
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

  /** Normalise a label / name — clé PARTAGÉE avec les alias (`tier_aliases`). */
  private norm(s: any): string {
    return normalizeTierName(s);
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

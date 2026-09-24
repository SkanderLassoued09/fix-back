import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiDocument } from 'src/di/entities/di.entity';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import {
  GoogleSheetsClient,
  SheetCell,
} from 'src/google-sheets/google-sheets.client';
import { DiLogsDocument } from 'src/logs-di/entities/logs-di.entity';
import { StatDocument } from 'src/stat/entities/stat.entity';
import {
  ACTIONS_HEADERS,
  ActionsRowInput,
  CellFill,
  buildActionsRow,
  compareIdnum,
} from './actions-en-cours.rows';

export interface ActionsEnCoursExportResult {
  tabName: string;
  rows: number;
  /** Lien direct vers l'onglet de l'année. */
  url: string;
}

/** Mêmes couleurs que l'ancien Excel tenu à la main. */
const FILL_HEX: Record<Exclude<CellFill, null>, string> = {
  green: '00B050',
  orange: 'FFC000',
  red: 'FF0000',
};
const TITLE_HEX = '00B0F0';

/** Largeurs en pixels, colonnes A → L. */
const COLUMN_WIDTHS = [70, 240, 140, 200, 110, 80, 190, 190, 190, 110, 190, 190];

/**
 * « ACTIONS EN COURS » généré par l'ERP — remplace l'Excel tenu à la main.
 *
 * Écrit dans le Google Sheet `ACTIONS_EN_COURS_SHEET_ID` (réglé en PRODUCTION
 * seulement : sans lui le job ne fait rien, donc dev/preprod n'écrivent jamais
 * dans le classeur de l'entreprise). UN onglet par année, `ACTIONS {année}`,
 * réécrit en entier à 12 h et 17 h (Africa/Tunis) ; au 1er janvier l'onglet de
 * l'année suivante est créé et le précédent n'est plus jamais touché.
 *
 * Contenu : TOUTES les DI de l'ERP (non supprimées), triées par N° DI. Colonnes
 * et code couleur de l'ancien fichier (voir `actions-en-cours.rows.ts`) ; les
 * documents affichent le nom Drive standard réduit au jour, lié au PDF.
 */
@Injectable()
export class ActionsEnCoursExportService {
  private readonly logger = new Logger(ActionsEnCoursExportService.name);

  constructor(
    @InjectModel('Di') private readonly diModel: Model<DiDocument>,
    @InjectModel('LogsDi') private readonly logsDiModel: Model<DiLogsDocument>,
    @InjectModel('Stat') private readonly statModel: Model<StatDocument>,
    @InjectModel('Profile') private readonly profileModel: Model<any>,
    private readonly sheets: GoogleSheetsClient,
    private readonly discord: DiscordHookService,
  ) {}

  /** Année courante vue à Tunis (le 31/12 à 23 h 30 UTC est déjà 2027 là-bas). */
  currentYear(at: Date = new Date()): number {
    return Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: process.env.APP_TIMEZONE || 'Africa/Tunis',
        year: 'numeric',
      }).format(at),
    );
  }

  buildTabName(year: number): string {
    return `ACTIONS ${year}`;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Données
  // ───────────────────────────────────────────────────────────────────────

  async loadRows(): Promise<ActionsRowInput[]> {
    const dis: any[] = await this.diModel
      .find({ isDeleted: { $ne: true } })
      .populate('client_id', 'first_name last_name')
      .populate('company_id', 'name')
      .populate('location_id', 'location_name')
      .lean()
      .exec();

    const ids = dis.map((d) => d._id);
    const [logs, stats] = await Promise.all([
      this.logsDiModel
        .find({ _idDi: { $in: ids } })
        .select(
          '_idDi idIgnore driveDocs docNumeros devis bon_de_commande bon_de_livraison facture',
        )
        .lean()
        .exec(),
      this.statModel
        .find({ _idDi: { $in: ids } })
        .select('_idDi ignoreCount id_tech_diag id_tech_rep')
        .lean()
        .exec(),
    ]);

    const logsByDi = new Map<string, any[]>();
    for (const l of logs as any[]) {
      const arr = logsByDi.get(l._idDi) ?? [];
      arr.push(l);
      logsByDi.set(l._idDi, arr);
    }
    const statsByDi = new Map<string, any[]>();
    for (const s of stats as any[]) {
      const arr = statsByDi.get(s._idDi) ?? [];
      arr.push(s);
      statsByDi.set(s._idDi, arr);
    }

    const techIds = new Set<string>();
    for (const s of stats as any[]) {
      if (s.id_tech_diag) techIds.add(String(s.id_tech_diag));
      if (s.id_tech_rep) techIds.add(String(s.id_tech_rep));
    }
    const techNames = await this.loadTechNames([...techIds]);

    return dis
      .map((di) => {
        const cycle = di.ignoreCount ?? 0;
        const diStats = statsByDi.get(di._id) ?? [];
        // Stat du cycle COURANT ; repli sur celle sans ignoreCount (legacy).
        const stat =
          diStats.find((s) => (s.ignoreCount ?? 0) === cycle) ??
          diStats.find((s) => s.ignoreCount == null) ??
          null;
        return {
          _idnum: di._idnum ?? di._id,
          title: di.title,
          nSerie: di.nSerie,
          clientName: this.clientName(di),
          locationName: this.locationName(di),
          dateReception: di.dateReception ?? null,
          createdAt: di.createdAt ?? null,
          status: di.status,
          ignoreCount: cycle,
          statusHistory: di.statusHistory ?? [],
          statusUpdatedAt: di.statusUpdatedAt ?? null,
          retourDate: di.retourDate ?? null,
          annulationParClient: di.annulationParClient ?? false,
          driveDocs: di.driveDocs ?? {},
          docNumeros: di.docNumeros ?? {},
          devis: di.devis ?? null,
          bon_de_commande: di.bon_de_commande ?? null,
          bon_de_livraison: di.bon_de_livraison ?? null,
          facture: di.facture ?? null,
          cycles: logsByDi.get(di._id) ?? [],
          techDiag: stat?.id_tech_diag
            ? techNames.get(String(stat.id_tech_diag)) ?? null
            : null,
          techRep: stat?.id_tech_rep
            ? techNames.get(String(stat.id_tech_rep)) ?? null
            : null,
        } as ActionsRowInput;
      })
      .sort((a, b) => compareIdnum(a._idnum, b._idnum));
  }

  private async loadTechNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const valid = ids.filter((id) => /^[a-f0-9]{24}$/i.test(id));
    if (!valid.length) return out;
    const profiles = await this.profileModel
      .find({ _id: { $in: valid } })
      .select('username first_name last_name')
      .lean()
      .exec();
    for (const p of profiles as any[]) {
      out.set(String(p._id), p.username || p.first_name || '');
    }
    return out;
  }

  private clientName(di: any): string {
    const co = di.company_id;
    if (co && typeof co === 'object' && co.name) return String(co.name);
    const c = di.client_id;
    if (c && typeof c === 'object') {
      const full = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
      if (full) return full;
    }
    return '';
  }

  private locationName(di: any): string {
    const l = di.location_id;
    if (l && typeof l === 'object' && l.location_name) {
      return String(l.location_name);
    }
    return '';
  }

  // ───────────────────────────────────────────────────────────────────────
  // Grille
  // ───────────────────────────────────────────────────────────────────────

  /** Titre (ligne 1) + en-têtes (ligne 2) + une ligne par DI, avec couleurs. */
  buildGrid(year: number, rows: ActionsRowInput[]): SheetCell[][] {
    // Titre NON fusionné : Sheets refuse de figer la colonne A si elle coupe
    // une fusion. Le texte déborde sur la ligne, bleue sur toute la largeur.
    const title: SheetCell[] = ACTIONS_HEADERS.map((_, i) =>
      i === 0
        ? {
            value: `ACTIONS EN COURS ${year}`,
            background: TITLE_HEX,
            bold: true,
            fontSize: 14,
            overflow: true,
          }
        : { background: TITLE_HEX },
    );
    const header: SheetCell[] = ACTIONS_HEADERS.map((h) => ({
      value: h.trim(),
      bold: true,
      align: 'CENTER',
    }));
    const body = rows.map((input) =>
      buildActionsRow(input).map(
        (c): SheetCell => ({
          value: c.value,
          background: c.fill ? FILL_HEX[c.fill] : null,
          links: c.links,
        }),
      ),
    );
    return [title, header, ...body];
  }

  // ───────────────────────────────────────────────────────────────────────
  // Publication
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Réécrit l'onglet de l'année. Sans `ACTIONS_EN_COURS_SHEET_ID` : journalise
   * et ne fait RIEN (retourne null). Un échec est signalé sur Discord puis
   * RELANCÉ (le déclencheur ACTION sort en code 1 ; le cron le journalise).
   */
  async publish(
    year: number = this.currentYear(),
  ): Promise<ActionsEnCoursExportResult | null> {
    const env = (process.env.NODE_ENV || 'development').trim();
    const spreadsheetId = process.env.ACTIONS_EN_COURS_SHEET_ID?.trim();
    const tabName = this.buildTabName(year);
    if (!spreadsheetId) {
      this.logger.log(
        `Export ACTIONS EN COURS [${env}] non configuré (ACTIONS_EN_COURS_SHEET_ID vide) — rien écrit.`,
      );
      return null;
    }
    try {
      const rows = await this.loadRows();
      const grid = this.buildGrid(year, rows);
      const gid = await this.sheets.writeFormattedTab(spreadsheetId, tabName, grid, {
        frozenRows: 2,
        frozenColumns: 1,
        columnWidths: COLUMN_WIDTHS,
        filterHeaderRow: 1,
        bordersFromRow: 1,
      });
      const result: ActionsEnCoursExportResult = {
        tabName,
        rows: rows.length,
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`,
      };
      this.logger.log(
        `Export ACTIONS EN COURS [${env}] : onglet « ${tabName} » réécrit (${result.rows} DI)`,
      );
      return result;
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      this.logger.error(`ÉCHEC export ACTIONS EN COURS [${env}] : ${reason}`);
      try {
        await this.discord.sendActionsEnCoursExportFailure({
          reason,
          fileName: tabName,
          env,
        });
      } catch (alertErr) {
        this.logger.warn(
          `Alerte Discord non envoyée : ${(alertErr as Error).message}`,
        );
      }
      throw err;
    }
  }
}

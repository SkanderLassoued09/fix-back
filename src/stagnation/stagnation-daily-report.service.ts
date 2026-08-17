import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GoogleSheetsClient } from 'src/google-sheets/google-sheets.client';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { NotificationService } from 'src/notifications/notification.service';
import { StagnationService } from './stagnation.service';
import {
  StagnationDispatch,
  StagnationDispatchDocument,
} from './entities/stagnation-dispatch.entity';

/**
 * RAPPORT QUOTIDIEN DE STAGNATION (24h) — orchestration pure, déclenchée par le
 * cron existant de 08:00 (`AppCronService.triggerStagnationDetection`) et par
 * l'ACTION runtime. NE crée PAS d'architecture parallèle : réutilise
 *   - `StagnationService` (détection, source `statusUpdatedAt`),
 *   - `GoogleSheetsClient` (feuille, création d'onglet + entête auto),
 *   - `NotificationService.emit` (cloche + toast + son, type DAILY_REMINDER),
 *   - `DiscordHookService` (chemin NON-gated APP_ALERT).
 *
 * IDÉMPOTENCE : une entrée `stagnation_dispatches` par (date, _idNum, statut)
 * avec index unique — un ré-run le même jour ne duplique NI ligne feuille NI
 * notification NI Discord. La date dans la clé fait que la même DI toujours
 * stagnante réapparaît le lendemain (récurrence journalière).
 */
@Injectable()
export class StagnationDailyReportService {
  private readonly logger = new Logger(StagnationDailyReportService.name);

  private static readonly THRESHOLD_HOURS = 24;
  /** Seuil de détection (constante) — sert au résumé Discord/ERP, PAS aux lignes
   *  (chaque ligne porte désormais la durée RÉELLE écoulée, cf. `humanizeAge`). */
  private static readonly SEUIL = 24;
  private static readonly UNITE = 'heures';
  /** Destinataires ERP par défaut (tous les rôles de suivi SAUF Magasin/Tech). */
  private static readonly ROLES = [
    'Coordinator',
    'Manager',
    'Admin_Manager',
    'Admin_Tech',
  ];
  /** Entête FR — colonne 1 = « ID : » ; « Durée »/« Unité » portent la durée
   *  réelle écoulée (jours/heures), pas le seuil. Colorée à la création (cf.
   *  `GoogleSheetsClient.ensureTab`). */
  private static readonly HEADER = [
    'ID :',
    'Statut',
    'Durée',
    'Unité',
    'Message',
  ];
  private static readonly DIGEST_EXAMPLES = 8;

  constructor(
    private readonly stagnationService: StagnationService,
    private readonly sheets: GoogleSheetsClient,
    private readonly notificationService: NotificationService,
    private readonly discord: DiscordHookService,
    @InjectModel(StagnationDispatch.name)
    private readonly dispatchModel: Model<StagnationDispatchDocument>,
  ) {}

  /** Date de génération `YYYY-MM-DD` en Africa/Tunis (fuseau applicatif). */
  private today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Tunis',
    }).format(new Date());
  }

  /**
   * Formate une ancienneté (en heures) en durée FR lisible, avec l'unité la plus
   * parlante : < 24h → « X heure(s) » ; sinon → « X jour(s) » (plancher, donc
   * « depuis 10 jours » = au moins 10 jours pleins). Retourne aussi la valeur +
   * l'unité brutes pour les colonnes Durée/Unité de la feuille.
   */
  private humanizeAge(ageHours: number): {
    value: number;
    unit: string;
    text: string;
  } {
    const h = Math.max(0, Math.round(ageHours ?? 0));
    if (h < 24) {
      const unit = h > 1 ? 'heures' : 'heure';
      return { value: h, unit, text: `${h} ${unit}` };
    }
    const days = Math.floor(h / 24);
    const unit = days > 1 ? 'jours' : 'jour';
    return { value: days, unit, text: `${days} ${unit}` };
  }

  /** Message FR — durée RÉELLE écoulée (pas le seuil), unité adaptée. Ex. :
   *  « DI DI46 stagnante dans le statut NEGOTIATION1 depuis 10 jours. » */
  private message(idNum: string, status: string, durationText: string): string {
    return `DI ${idNum} stagnante dans le statut ${status} depuis ${durationText}.`;
  }

  /** Classeur cible : le classeur DÉDIÉ stagnation (`GOOGLE_SHEETS_SPREADSHEET_ID`)
   *  en priorité ; repli sur le classeur d'export existant (`GOOGLE_SHEETS_ID`). */
  private spreadsheetId(): string {
    return (
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID ||
      process.env.GOOGLE_STAGNATION_SHEETS_ID ||
      process.env.GOOGLE_SHEETS_ID ||
      ''
    );
  }

  /** Lien Google Sheets : PROFOND vers l'onglet (`?gid=<gid>#gid=<gid>`) quand
   *  le gid est connu, sinon lien classeur. Chaîne vide si pas de classeur. */
  private buildSheetUrl(spreadsheetId: string, gid: number | null): string {
    if (!spreadsheetId) return '';
    const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
    return gid != null ? `${base}?gid=${gid}#gid=${gid}` : base;
  }

  /**
   * Exécute le rapport quotidien. Retourne un résumé pour le log du cron.
   */
  async run(): Promise<{
    date: string;
    detected: number;
    dispatched: number;
    skipped: number;
  }> {
    const date = this.today();
    this.logger.log(`START daily stagnation report · date=${date}`);

    const stagnant = await this.stagnationService.getStagnantForDailyReport(
      StagnationDailyReportService.THRESHOLD_HOURS,
    );

    // Idempotence : on RÉSERVE chaque DI (insert clé unique {date,idNum,status}).
    // Un doublon (code 11000) signifie « déjà traité aujourd'hui » → on saute.
    const fresh: typeof stagnant = [];
    for (const di of stagnant) {
      try {
        await this.dispatchModel.create({
          date,
          idNum: di.idNum,
          status: di.status,
          ageHours: di.ageHours,
        });
        fresh.push(di);
      } catch (err: any) {
        if (err?.code === 11000) continue; // déjà dispatché aujourd'hui
        throw err; // vraie erreur DB → remonte (le cron catch au-dessus)
      }
    }

    if (!fresh.length) {
      this.logger.log(
        `END daily stagnation report · date=${date} · detected=${stagnant.length} · 0 new (idempotent no-op)`,
      );
      return {
        date,
        detected: stagnant.length,
        dispatched: 0,
        skipped: stagnant.length,
      };
    }

    // 1) Feuille Google : onglet = date du jour. `appendRows` crée l'onglet +
    //    l'entête (colorée) si absent (jamais d'écrasement des jours précédents).
    const spreadsheetId = this.spreadsheetId();
    try {
      const rows = fresh.map((di) => {
        const age = this.humanizeAge(di.ageHours);
        return [
          di.idNum,
          di.status,
          age.value, // Durée RÉELLE (jours ou heures selon l'ancienneté)
          age.unit, // « jours » / « jour » / « heures » / « heure »
          this.message(di.idNum, di.status, age.text),
        ];
      });
      await this.sheets.appendRows(
        `${date}!A:E`,
        rows,
        StagnationDailyReportService.HEADER,
        spreadsheetId,
      );
    } catch (err) {
      this.logger.error(
        `Feuille stagnation ${date} non écrite: ${(err as Error).message}`,
      );
    }

    // Lien PROFOND vers l'onglet du jour (`…/edit?gid=<gid>#gid=<gid>`) — pour
    // le Discord et la cloche ERP. Best-effort : si le gid ne se résout pas, on
    // retombe sur le lien classeur (voir `buildSheetUrl`).
    let sheetUrl = '';
    if (spreadsheetId) {
      try {
        const gid = await this.sheets.getSheetGid(spreadsheetId, date);
        sheetUrl = this.buildSheetUrl(spreadsheetId, gid);
      } catch (err) {
        sheetUrl = this.buildSheetUrl(spreadsheetId, null);
        this.logger.warn(
          `gid onglet ${date} non résolu: ${(err as Error).message}`,
        );
      }
    }

    // 2) Notification ERP DAILY_REMINDER (cloche + toast + son) — UN RÉSUMÉ
    //    par exécution (pas une notif par DI : avec des dizaines de DI stagnantes
    //    ça noierait la cloche). Le détail par DI est dans la feuille du jour.
    try {
      const example = fresh
        .slice(0, StagnationDailyReportService.DIGEST_EXAMPLES)
        .map((di) => di.idNum)
        .join(', ');
      const summary =
        `${fresh.length} DI stagnante(s) dans le même statut depuis plus de ` +
        `${StagnationDailyReportService.SEUIL} ${StagnationDailyReportService.UNITE}` +
        (example ? ` (${example}${fresh.length > StagnationDailyReportService.DIGEST_EXAMPLES ? '…' : ''})` : '') +
        ` — voir la feuille ${date}.`;
      await this.notificationService.emit({
        type: 'DAILY_REMINDER',
        diId: null,
        actorId: null,
        message: summary,
        payload: {
          date,
          count: fresh.length,
          seuil: StagnationDailyReportService.SEUIL,
          unite: StagnationDailyReportService.UNITE,
          url: sheetUrl || undefined, // lien feuille pour la cloche (front)
        },
        notify: { roles: StagnationDailyReportService.ROLES },
      });
    } catch (err) {
      this.logger.warn(
        `DAILY_REMINDER emit échoué: ${(err as Error).message}`,
      );
    }

    // 3) UN seul Discord vers APP_ALERT (chemin non-gated).
    try {
      await this.discord.sendDailyStagnationReminder({
        date,
        count: fresh.length,
        seuil: StagnationDailyReportService.SEUIL,
        unite: StagnationDailyReportService.UNITE,
        examples: fresh
          .slice(0, StagnationDailyReportService.DIGEST_EXAMPLES)
          .map((di) => di.idNum),
        spreadsheetUrl: sheetUrl || undefined,
      });
    } catch (err) {
      this.logger.error(
        `Discord rappel stagnation échoué: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `END daily stagnation report · date=${date} · detected=${stagnant.length} · dispatched=${fresh.length}`,
    );
    return {
      date,
      detected: stagnant.length,
      dispatched: fresh.length,
      skipped: stagnant.length - fresh.length,
    };
  }
}

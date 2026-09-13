import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

/** Relance « bon de livraison à téléverser » — la SEULE notification exemptée
 *  de la purge par ancienneté, tant que le BL n'est pas déposé. */
const BL_PENDING_TYPE = 'DI_DOC_BL_PENDING';

/**
 * Statuts où le BL est encore ATTENDU.
 *
 * Volontairement PLUS ÉTROIT que `CLOSING_STATUS_VALUES` (di.status.ts), qui
 * inclut `WAITING_FACTURE` : ce statut signifie que le BL est DÉJÀ arrivé et
 * qu'on attend la facture. L'y inclure conserverait indéfiniment des relances
 * pour un document déjà fourni. Les deux valeurs legacy sont gardées : les
 * bases non migrées (008) y stationnent encore.
 */
const BL_AWAITED_STATUSES: readonly string[] = [
  'WAITING_BL',
  'CLOSING',
  'ATTENTE_BL_FACTURE',
];

/** Rétention des notifications **LUES** : 3 jours après leur création.
 *  Les NON-LUES ne sont PAS concernées — elles relèvent du TTL `readAt`
 *  (90 j après lecture) porté par l'index de l'entité. */
const RETENTION_DAYS = 3;

export interface PurgeResult {
  /** Lignes réellement supprimées (0 en simulation). */
  deleted: number;
  /** Lignes de plus de 3 jours ÉPARGNÉES car le BL manque toujours. */
  keptBlPending: number;
  /** Lignes récentes, hors périmètre. */
  recent: number;
}

/**
 * PURGE DES NOTIFICATIONS — efface les notifications DÉJÀ LUES de plus de
 * 3 jours.
 *
 * CE QU'ELLE NE TOUCHE PAS : les NON-LUES. Elle les effaçait auparavant (le
 * filtre ne portait que sur `createdAt`), ce qui vidait la cloche d'un absent
 * et rendait le TTL de 90 j de l'entité inatteignable. Une non-lue vit
 * désormais jusqu'à sa lecture, puis 90 j via l'index TTL sur `readAt`.
 *
 * PORTÉE. Uniquement la collection `notifications` (une ligne par
 * destinataire). `system_events` n'est JAMAIS touché : c'est le journal ERP
 * append-only, conservé volontairement (valeur ISO 9001), et c'est lui qui
 * alimente l'onglet « Journal » du dossier d'intervention. Le contenu d'une
 * notification supprimée reste donc consultable là-bas.
 *
 * EXCEPTION BL. Une relance `DI_DOC_BL_PENDING` survit à son ancienneté tant
 * que le bon de livraison n'a pas été déposé. Le front décide de faire battre
 * la cloche par la simple PRÉSENCE de cette ligne (jamais selon `readAt`) :
 * la supprimer alors que le document manque encore éteindrait définitivement
 * la relance — plus de battement, plus de bouton snooze, plus de lien direct
 * vers le modal d'upload — et rien ne la recrée hors des créneaux du cron
 * `remindPendingBl` (2 h, lun-sam 08-18 h), qui ne couvre en outre ni les
 * statuts legacy ni les DI de retour.
 *
 * Déclenché à 03 h Africa/Tunis par `AppCronService`.
 */
@Injectable()
export class NotificationPurgeService {
  private readonly logger = new Logger(NotificationPurgeService.name);

  constructor(
    @InjectModel('Notification')
    private readonly notificationModel: Model<any>,
    @InjectModel('Di') private readonly diModel: Model<any>,
    @InjectModel('LogsDi') private readonly logsDiModel: Model<any>,
  ) {}

  /**
   * @param dryRun n'écrit rien, compte seulement — à lancer avant la première
   *   purge réelle pour vérifier les volumes.
   */
  async run(dryRun = false): Promise<PurgeResult> {
    this.logger.log(
      `START purge des notifications · rétention=${RETENTION_DAYS}j${
        dryRun ? ' · SIMULATION' : ''
      }`,
    );

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);

    // ⚠️ Le filtre `{ createdAt: { $lt: cutoff } }` est INDISPENSABLE — ne
    // jamais le remplacer par `{}`. Il borne la purge aux lignes réellement
    // périmées ; un filtre vide viderait la cloche de tout le monde, y compris
    // les notifications du jour et les relances BL vivantes.
    //
    // ⚠️ `readAt: { $ne: null }` est tout aussi INDISPENSABLE : la purge
    // n'efface que les notifications DÉJÀ LUES. Sans ce prédicat elle
    // supprimait aussi les NON-LUES, ce qui (a) contredisait le contrat écrit
    // sur l'entité (« les NON-LUES restent indéfiniment »), (b) rendait son
    // index TTL de 90 j inatteignable — rien ne survivait à 3 jours — et
    // (c) vidait la cloche d'un utilisateur absent un long week-end : le badge
    // retombait à 0 sans qu'il ait rien vu. Les non-lues relèvent désormais du
    // SEUL TTL `readAt` (90 j après lecture), comme l'entité le décrit.
    const stale: any[] = await this.notificationModel
      .find({ createdAt: { $lt: cutoff }, readAt: { $ne: null } })
      .select('_id type diId')
      .lean();

    // Les candidates à l'exemption sont peu nombreuses : on ne charge une DI
    // que pour celles-là, et une seule fois par DI (les notifications sont
    // dupliquées par destinataire).
    const blCandidates = stale.filter((n) => n.type === BL_PENDING_TYPE);
    const blMissingByDi = new Map<string, boolean>();
    for (const diId of new Set(
      blCandidates.map((n) => n.diId).filter(Boolean),
    )) {
      blMissingByDi.set(diId, await this.isBlStillMissing(diId));
    }

    const toDelete = stale.filter(
      (n) =>
        !(
          n.type === BL_PENDING_TYPE &&
          n.diId &&
          blMissingByDi.get(n.diId) === true
        ),
    );
    const keptBlPending = stale.length - toDelete.length;

    let deleted = 0;
    if (!dryRun && toDelete.length) {
      const res = await this.notificationModel.deleteMany({
        _id: { $in: toDelete.map((n) => n._id) },
      });
      deleted = res?.deletedCount ?? 0;
    }

    const recent = await this.notificationModel.countDocuments({
      createdAt: { $gte: cutoff },
    });

    this.logger.log(
      `END purge des notifications · ${
        dryRun ? 'à supprimer' : 'supprimées'
      }=${dryRun ? toDelete.length : deleted} · BL épargnées=${keptBlPending} · récentes=${recent}`,
    );
    return { deleted: dryRun ? 0 : deleted, keptBlPending, recent };
  }

  /**
   * Le bon de livraison de cette DI est-il TOUJOURS attendu ?
   *
   * `false` (donc purgeable) dès que la question n'a plus de sens : DI absente
   * — les `diId` orphelins de DI supprimées ne doivent pas rester éternellement
   * — DI supprimée, ou phase de clôture déjà franchie.
   */
  private async isBlStillMissing(diId: string): Promise<boolean> {
    const di: any = await this.diModel
      .findOne({ _id: diId })
      .select('status isDeleted ignoreCount bon_de_livraison driveDocs')
      .lean();

    if (!di || di.isDeleted === true) return false;
    if (!BL_AWAITED_STATUSES.includes(di.status)) return false;

    // DI de RETOUR : `addBlPDF` écrit alors le BL UNIQUEMENT dans le log de
    // cycle, jamais sur la DI. Interroger la DI y verrait un BL manquant à
    // perpétuité et la relance ne serait jamais purgée.
    const cycle = di.ignoreCount ?? 0;
    if (cycle > 0) {
      const log: any = await this.logsDiModel
        .findOne({ _idDi: diId, idIgnore: cycle })
        .select('bon_de_livraison')
        .lean();
      return !log?.bon_de_livraison;
    }

    return !(this.isDriveDocRef(di?.driveDocs?.BL) || !!di.bon_de_livraison);
  }

  /**
   * Une entrée `driveDocs` est-elle une VRAIE référence Drive ? Reproduit
   * `DiService.isDriveDocRef` (privé) plutôt que d'élargir la surface publique
   * du service DI pour un job de nettoyage. Rejette les valeurs legacy où le
   * champ n'était qu'un nom de fichier.
   */
  private isDriveDocRef(doc: any): boolean {
    return !!doc && typeof doc === 'object' && !!doc.driveFileId;
  }
}

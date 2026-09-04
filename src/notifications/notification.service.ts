import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NotificationsGateway } from '../notification.gateway';
import { NotificationDocument } from './entities/notification.entity';
import { SystemEventDocument } from './entities/system-event.entity';
import { toProfileRoles } from './role-mapping';

/** Cible d'une notification actionnable. Vide/absente ⇒ historique seul. */
export interface EmitTarget {
  userIds?: string[];
  roles?: string[];
}

export interface EmitInput {
  type: string;
  message: string;
  diId?: string | null;
  /** Acteur authentifié ; `null`/absent ⇒ « acteur inconnu » (jamais deviné). */
  actorId?: string | null;
  actorRole?: string | null;
  payload?: Record<string, any>;
  /** Destinataires de la CLOCHE. Absent ⇒ événement d'historique uniquement. */
  notify?: EmitTarget;
}

/**
 * Émetteur CENTRAL du système notifications + historique.
 *   1. écrit TOUJOURS un `SystemEvent` (historique) ;
 *   2. si `notify` (actionnable) : crée une ligne `Notification` FINE par
 *      destinataire (rôles étendus en userIds, acteur exclu de ses propres
 *      notifs) ;
 *   3. pousse au socket vers les rooms `user:{id}` UNIQUEMENT (ciblé, pas de
 *      broadcast) → un utilisateur ne reçoit QUE ses notifications.
 *
 * La fusion `di_alerts` passe par ici (les alertes appellent `emit`), donc les
 * 215 alertes EXISTANTES ne créent aucune notification : le badge démarre à 0.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('NotificationService');

  constructor(
    @InjectModel('SystemEvent')
    private readonly eventModel: Model<SystemEventDocument>,
    @InjectModel('Notification')
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel('Profile')
    private readonly profileModel: Model<any>,
    private readonly gateway: NotificationsGateway,
  ) {}

  /** Étend une liste de rôles en ids d'utilisateurs (ciblage « toute la
   *  coordination »). Aligne d'abord le vocabulaire via `toProfileRoles`
   *  (SOURCE UNIQUE) ; un rôle non résolu n'est JAMAIS silencieux → il est
   *  loggué (l'événement d'historique reste écrit, le badge n'est pas gonflé). */
  private async userIdsForRoles(roles: string[]): Promise<string[]> {
    if (!roles?.length) return [];
    const { resolved, unresolved } = toProfileRoles(roles);
    if (unresolved.length) {
      this.logger.warn(
        `Rôle(s) de ciblage non résolus (notification ignorée, historique conservé) : ${unresolved.join(
          ', ',
        )}`,
      );
    }
    if (!resolved.length) return [];
    const profiles = await this.profileModel
      .find({ role: { $in: resolved } }, { _id: 1 })
      .lean();
    return (profiles as any[]).map((p) => String(p._id));
  }

  /**
   * `actorId` → nom affichable, en UNE requête pour tout un lot d'événements.
   * Le journal ne doit jamais montrer un ObjectId : le front le filtre, et la
   * ligne se lit alors « par — », pire qu'une absence.
   */
  async resolveActorNames(
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean) as string[])];
    const out = new Map<string, string>();
    if (!unique.length) return out;
    const profiles = await this.profileModel
      .find({ _id: { $in: unique } }, { firstName: 1, lastName: 1, username: 1 })
      .lean();
    for (const p of profiles as any[]) {
      const name =
        [p.firstName, p.lastName].filter(Boolean).join(' ').trim() ||
        p.username ||
        '';
      if (name) out.set(String(p._id), name);
    }
    return out;
  }

  async emit(input: EmitInput): Promise<SystemEventDocument> {
    // 1) Historique — toujours.
    const event = await this.eventModel.create({
      type: input.type,
      diId: input.diId ?? null,
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      message: input.message,
      payload: input.payload ?? {},
    });

    // 2) Cloche — seulement si actionnable (destinataires fournis).
    const target = input.notify;
    if (target && (target.userIds?.length || target.roles?.length)) {
      const fromRoles = await this.userIdsForRoles(target.roles ?? []);
      const all = new Set<string>([...(target.userIds ?? []), ...fromRoles]);
      // On ne se notifie pas soi-même (l'acteur sait ce qu'il vient de faire).
      if (input.actorId) all.delete(String(input.actorId));

      const recipients = [...all].filter(Boolean);
      if (recipients.length) {
        const rows = recipients.map((userId) => ({
          eventId: String(event._id),
          userId,
          readAt: null,
          type: input.type,
          diId: input.diId ?? null,
          message: input.message,
        }));
        const created = await this.notificationModel.insertMany(rows, {
          ordered: false,
        });
        // 3) Push socket CIBLÉ (room par utilisateur) — best-effort.
        for (const doc of created as any[]) {
          try {
            this.gateway.emitToUser(String(doc.userId), {
              _id: String(doc._id),
              eventId: doc.eventId,
              type: doc.type,
              diId: doc.diId ?? null,
              message: doc.message,
              createdAt: doc.createdAt,
              actionable: true,
            });
          } catch (err) {
            this.logger.warn(
              `emitToUser a échoué (userId=${doc.userId}): ${
                (err as Error)?.message ?? err
              }`,
            );
          }
        }
      }
    }
    return event;
  }

  /** Compteur de NON-LUS — `count` INDEXÉ, jamais un chargement de liste. */
  async unreadCount(userId: string): Promise<number> {
    if (!userId) return 0;
    return this.notificationModel.countDocuments({ userId, readAt: null });
  }

  /** Liste paginée de la cloche (récent d'abord). */
  async listForUser(
    userId: string,
    opts: { limit?: number; before?: Date } = {},
  ): Promise<NotificationDocument[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const filter: any = { userId };
    if (opts.before) filter.createdAt = { $lt: opts.before };
    return this.notificationModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean() as any;
  }

  /** Marque UNE notification lue — SCOPÉ à l'utilisateur (isolation). */
  async markRead(userId: string, notifId: string): Promise<boolean> {
    const res = await this.notificationModel.updateOne(
      { _id: notifId, userId, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return (res as any)?.modifiedCount > 0;
  }

  /** Marque TOUTES les non-lues de l'utilisateur comme lues. */
  async markAllRead(userId: string): Promise<number> {
    const res = await this.notificationModel.updateMany(
      { userId, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return (res as any)?.modifiedCount ?? 0;
  }

  /**
   * Supprime les lignes de cloche d'une DI pour un type donné (l'historique
   * `system_events` est conservé). Sert aux rappels « nagging » (item 5) : on
   * garde UNE seule relance vivante par DI (efface l'ancienne avant la nouvelle)
   * et on éteint la relance dès que le document attendu est fourni.
   */
  async clearByDiAndType(diId: string, type: string): Promise<number> {
    if (!diId || !type) return 0;
    // Capture les destinataires AVANT suppression pour les prévenir en temps
    // réel (le front retire la ligne + coupe le son immédiatement, sans attendre
    // un re-fetch de la cloche).
    const rows = await this.notificationModel
      .find({ diId, type })
      .select('userId')
      .lean();
    const res = await this.notificationModel.deleteMany({ diId, type });
    const userIds = Array.from(
      new Set(rows.map((r: any) => String(r.userId)).filter(Boolean)),
    );
    for (const userId of userIds) {
      try {
        this.gateway.emitRemovedToUser(userId, { diId, type });
      } catch {
        /* best-effort */
      }
    }
    return (res as any)?.deletedCount ?? 0;
  }

  /** Préférence son (défaut ON si le profil n'a pas encore le champ). */
  async getSoundPref(userId: string): Promise<boolean> {
    const p = await this.profileModel
      .findOne({ _id: userId }, { notificationSound: 1 })
      .lean();
    return (p as any)?.notificationSound !== false;
  }

  async setSoundPref(userId: string, enabled: boolean): Promise<boolean> {
    await this.profileModel.updateOne(
      { _id: userId },
      { $set: { notificationSound: !!enabled } },
    );
    return !!enabled;
  }

  /** Historique paginé + filtré (jamais illimité). */
  async listHistory(
    filter: {
      diId?: string;
      type?: string;
      actorId?: string;
      limit?: number;
      skip?: number;
    } = {},
  ): Promise<SystemEventDocument[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const skip = Math.max(filter.skip ?? 0, 0);
    const q: any = {};
    if (filter.diId) q.diId = filter.diId;
    if (filter.type) q.type = filter.type;
    if (filter.actorId) q.actorId = filter.actorId;
    return this.eventModel
      .find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean() as any;
  }
}

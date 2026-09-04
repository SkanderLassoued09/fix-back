import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { Profile } from 'src/profile/entities/profile.entity';
import { NotificationService } from './notification.service';
import { Notification } from './entities/notification.entity';
import { SystemEvent } from './entities/system-event.entity';

/**
 * Toutes les opérations sont AUTHENTIFIÉES (`@CurrentUser`) : le serveur lit
 * l'utilisateur du JWT, JAMAIS un id fourni par le client → un utilisateur ne
 * peut voir/marquer QUE ses propres notifications.
 */
@Resolver()
export class NotificationResolver {
  constructor(private readonly service: NotificationService) {}

  /** Badge : `count` indexé sur {userId, readAt} — jamais un chargement de liste. */
  @Query(() => Int)
  @UseGuards(JwtAuthGuard)
  async unreadNotificationCount(
    @CurrentUser() profile: Profile,
  ): Promise<number> {
    return this.service.unreadCount(profile._id);
  }

  @Query(() => [Notification])
  @UseGuards(JwtAuthGuard)
  async myNotifications(
    @CurrentUser() profile: Profile,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<Notification[]> {
    return this.service.listForUser(profile._id, { limit }) as any;
  }

  @Query(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async notificationSoundEnabled(
    @CurrentUser() profile: Profile,
  ): Promise<boolean> {
    return this.service.getSoundPref(profile._id);
  }

  @Query(() => [SystemEvent])
  @UseGuards(JwtAuthGuard)
  async notificationHistory(
    @CurrentUser() _profile: Profile,
    @Args('diId', { nullable: true }) diId?: string,
    @Args('type', { nullable: true }) type?: string,
    @Args('actorId', { nullable: true }) actorId?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('skip', { type: () => Int, nullable: true }) skip?: number,
  ): Promise<SystemEvent[]> {
    const rows = await this.service.listHistory({
      diId,
      type,
      actorId,
      limit,
      skip,
    });
    // Acteurs résolus en NOMS en UNE requête (le journal d'une DI répète
    // largement les mêmes auteurs).
    const names = await this.service.resolveActorNames(
      (rows as any[]).map((e) => e?.actorId),
    );
    return rows.map((e: any) => ({
      _id: String(e._id),
      type: e.type,
      diId: e.diId ?? undefined,
      actorId: e.actorId ?? undefined,
      actorRole: e.actorRole ?? undefined,
      actorName: (e.actorId && names.get(e.actorId)) || undefined,
      message: e.message,
      payloadJson: e.payload ? JSON.stringify(e.payload) : undefined,
      createdAt: e.createdAt,
    }));
  }

  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async markNotificationRead(
    @CurrentUser() profile: Profile,
    @Args('notifId') notifId: string,
  ): Promise<boolean> {
    return this.service.markRead(profile._id, notifId);
  }

  @Mutation(() => Int)
  @UseGuards(JwtAuthGuard)
  async markAllNotificationsRead(
    @CurrentUser() profile: Profile,
  ): Promise<number> {
    return this.service.markAllRead(profile._id);
  }

  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async setNotificationSound(
    @CurrentUser() profile: Profile,
    @Args('enabled') enabled: boolean,
  ): Promise<boolean> {
    return this.service.setSoundPref(profile._id, enabled);
  }
}

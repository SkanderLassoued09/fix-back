import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { Profile } from 'src/profile/entities/profile.entity';
import { NotificationService } from './notification.service';
import { Notification } from './entities/notification.entity';
import { SystemEvent } from './entities/system-event.entity';
import { withErrorContext } from '../common/error-context';

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
    try {
      return await this.service.unreadCount(profile._id);
    } catch (error) {
      throw withErrorContext(
        error,
        'NotificationResolver.unreadNotificationCount',
      );
    }
  }

  @Query(() => [Notification])
  @UseGuards(JwtAuthGuard)
  async myNotifications(
    @CurrentUser() profile: Profile,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<Notification[]> {
    try {
      return await (this.service.listForUser(profile._id, { limit }) as any);
    } catch (error) {
      throw withErrorContext(error, 'NotificationResolver.myNotifications');
    }
  }

  @Query(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async notificationSoundEnabled(
    @CurrentUser() profile: Profile,
  ): Promise<boolean> {
    try {
      return await this.service.getSoundPref(profile._id);
    } catch (error) {
      throw withErrorContext(
        error,
        'NotificationResolver.notificationSoundEnabled',
      );
    }
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
    try {
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
    } catch (error) {
      throw withErrorContext(error, 'NotificationResolver.notificationHistory');
    }
  }

  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async markNotificationRead(
    @CurrentUser() profile: Profile,
    @Args('notifId') notifId: string,
  ): Promise<boolean> {
    try {
      return await this.service.markRead(profile._id, notifId);
    } catch (error) {
      throw withErrorContext(
        error,
        'NotificationResolver.markNotificationRead',
      );
    }
  }

  @Mutation(() => Int)
  @UseGuards(JwtAuthGuard)
  async markAllNotificationsRead(
    @CurrentUser() profile: Profile,
  ): Promise<number> {
    try {
      return await this.service.markAllRead(profile._id);
    } catch (error) {
      throw withErrorContext(
        error,
        'NotificationResolver.markAllNotificationsRead',
      );
    }
  }

  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async setNotificationSound(
    @CurrentUser() profile: Profile,
    @Args('enabled') enabled: boolean,
  ): Promise<boolean> {
    try {
      return await this.service.setSoundPref(profile._id, enabled);
    } catch (error) {
      throw withErrorContext(
        error,
        'NotificationResolver.setNotificationSound',
      );
    }
  }
}

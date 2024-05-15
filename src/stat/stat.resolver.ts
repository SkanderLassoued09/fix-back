import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  Subscription,
} from '@nestjs/graphql';
import { StatService } from './stat.service';
import { CreateStatNotificationReturn, Stat } from './entities/stat.entity';
import { CreateStatInput } from './dto/create-stat.input';
import { UpdateStatInput } from './dto/update-stat.input';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { Profile } from 'src/profile/entities/profile.entity';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { PubSub } from 'graphql-subscriptions';

@Resolver(() => Stat)
export class StatResolver {
  constructor(
    private readonly statService: StatService,
    private readonly pubsub: PubSub,
  ) {}
  @Mutation(() => CreateStatNotificationReturn)
  createStat(@Args('createStatInput') createStatInput: CreateStatInput) {
    console.log('🥘[createStatInput]:', createStatInput);
    this.pubsub.publish('you-got-notification-diagnostic', {
      notificationDiagnostic: {
        _idDi: createStatInput._idDi,
        messageNotification: createStatInput.notificationMessage,
        _idtechDiag: createStatInput.id_tech_diag,
      },
    });
    return this.statService.createStat(createStatInput);
  }

  @Subscription(() => CreateStatNotificationReturn)
  notificationDiagnostic() {
    return this.pubsub.asyncIterator('you-got-notification-diagnostic');
  }

  @Mutation(() => Boolean)
  affectForRep(@Args('_idDi') _idDi: string, @Args('_idTech') _idTech: string) {
    const isAffected = this.statService.affectForRep(_idDi, _idTech);
    this.pubsub.publish('you-got-notification-reparation', {
      notificationReparation: {
        _idDi,
        messageNotification: 'createStatInput.notificationMessage',
        id_tech_diag: _idTech,
      },
    });
    if (isAffected) {
      return true;
    } else {
      false;
    }
  }
  @Subscription(() => CreateStatNotificationReturn)
  notificationReparation() {
    return this.pubsub.asyncIterator('you-got-notification-reparation');
  }

  /**
   * 
  this function for pause time fired when user press on pause 
   */

  @Mutation(() => Boolean)
  lapTimeForPauseAndGetBack(
    @Args('_id') _id: string,
    @Args('diagTime') diagTime: string,
  ) {
    const isUpdated = this.statService.lapTime(_id, diagTime);
    if (isUpdated) {
      return true;
    } else {
      false;
    }
  }

  /**
   * 
  this function will get last time pause to continue counting later 
   */
  @Query(() => Stat)
  getLastPauseTime(@Args('_id') _id: string) {
    return this.statService.getLastPauseTime(_id);
  }

  @Query(() => [Stat])
  @UseGuards(JwtAuthGuard)
  getDiForTech(@CurrentUser() tech: Profile) {
    return this.statService.getDiForTech(tech._id);
  }
}

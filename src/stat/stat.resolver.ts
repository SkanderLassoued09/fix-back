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
  // to create subscription
  /**
   *   constructor(
    private readonly userService: UserService,
    private readonly pubSub: PubSub,
  ) {}

  @Mutation(() => User)
  createUser(@Args('createUserInput') createUserInput: CreateUserInput) {
    console.log('🍯[createUserInput]:', createUserInput);
    this.pubSub.publish('userAdded', {
      userAdded: { _id: 0, name: 'Nezih' },
    });
    return { _id: 0, name: 'Nezih' };
  }
  @Subscription(() => User)
  userAdded() {
    return this.pubSub.asyncIterator('userAdded');
  }
  -----------------------
  service: 
  constructor(private readonly pubSub: PubSub) {}
  users = [{ _id: 1, name: 'Alo' }];
  create(createUserInput: CreateUserInput) {
    this.users.push(createUserInput).valueOf();
    console.log('🍸[result]:', this.users);
    // to shape of userAdded must correspond to shape defined in Subscription
    //  if doesnt  match would failed
    this.pubSub.publish('userAdded', {
      userAdded: { _id: 0, name: 'Aki' },
    });
    console.log('🥜[this.users]:', this.users);

    return this.users;
  }
   */

  @Mutation(() => Boolean)
  affectForDiag(
    @Args('_idDi') _idDi: string,
    @Args('_idTech') _idTech: string,
  ) {
    const isAffected = this.statService.affectForDiag(_idDi, _idTech);
    if (isAffected) {
      return true;
    } else {
      false;
    }
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

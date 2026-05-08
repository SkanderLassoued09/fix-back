import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  Subscription,
} from '@nestjs/graphql';
import { StatService } from './stat.service';
import {
  CreateStatNotificationReturn,
  DiReparationInfo,
  DiStatConsistencyReport,
  Stat,
  StatsCount,
  StatsTableData,
} from './entities/stat.entity';
import {
  CreateStatInput,
  PauseLogInput,
  SearchInput,
  UpdatedPauseTime,
} from './dto/create-stat.input';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { Profile } from 'src/profile/entities/profile.entity';
import { Logger, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { PubSub } from 'graphql-subscriptions';
import { PaginationConfigDi } from 'src/di/dto/create-di.input';

@Resolver(() => Stat)
export class StatResolver {
  private readonly logger = new Logger(StatResolver.name);

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

  @Mutation(() => Boolean)
  async affectForRep(
    @Args('_idDi') _idDi: string,
    @Args('_idTech') _idTech: string,
  ): Promise<boolean> {
    try {
      const result: any = await this.statService.affectForRep(_idDi, _idTech);
      const matchedCount =
        typeof result?.matchedCount === 'number' ? result.matchedCount : 0;
      const isAffected = matchedCount > 0;

      if (!isAffected) {
        this.logger.warn(
          `affectForRep: no Stat row matched for _idDi=${_idDi} _idTech=${_idTech} (matchedCount=${matchedCount})`,
        );
        return false;
      }

      await this.pubsub.publish('you-got-notification-reparation', {
        notificationReparation: {
          _idDi,
          messageNotification: 'createStatInput.notificationMessage',
          id_tech_diag: _idTech,
        },
      });

      return true;
    } catch (error) {
      this.logger.error(
        `affectForRep failed for _idDi=${_idDi} _idTech=${_idTech}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
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

  @Mutation(() => Boolean)
  lapTimeForPauseAndGetBackForReaparation(
    @Args('_id') _id: string,
    @Args('repTime') repTime: string,
  ) {
    const isUpdated = this.statService.lapTimeForReaparation(_id, repTime);
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

  /**
   * 
   We gonna create method to save diagnostic when tech id finish his work,
   functions for get last pause time for reparation  and one for lap time pause and back for reapration 
   */

  // this one to get last time when he makes pause for reapartion
  @Query(() => Stat)
  getLastPauseTimeforreaparation(@Args('_id') _id: string) {
    return this.statService.getLastPauseTimeForReparation(_id);
  }

  @Query(() => StatsTableData)
  @UseGuards(JwtAuthGuard)
  searchTechDI(
    @CurrentUser() profile: Profile,
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    @Args('search') search: SearchInput,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
  ) {
    // Convert the date strings to JavaScript Date objects if provided
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    return this.statService.searchTechDi(
      paginationConfig,
      search,
      profile._id,
      profile.role,
      start,
      end,
    );
  }

  @Query(() => StatsTableData)
  @UseGuards(JwtAuthGuard)
  getDiForTech(
    @CurrentUser() profile: Profile,
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
  ) {
    // Convert the date strings to JavaScript Date objects if provided
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    return this.statService.getDiForTech(
      paginationConfig,
      profile._id,
      profile.role,
      start,
      end,
    );
  }

  @Query(() => [StatsCount])
  @UseGuards(JwtAuthGuard)
  getDiStatusCounts(
    @CurrentUser() tech: Profile,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
  ) {
    // Convert the date strings to JavaScript Date objects if provided
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    return this.statService.getDiStatusCounts(tech._id, start, end);
  }

  @Query(() => Stat)
  async getStatbyID(@Args('_idSTAT') _idSTAT: string) {
    return await this.statService.getDIByStat(_idSTAT);
  }

  @Query(() => DiReparationInfo)
  async getStatInfoForTechReparation(@Args('_idDi') _idDi: string) {
    const value = await this.statService.getStatInfoForTechReparation(_idDi);

    return value;
  }

  @Query(() => Stat)
  getInfoStatByIdDi(
    @Args('_idDi') _idDi: string,
    @Args('_idLogs', { nullable: true }) _idLogs: number,
  ) {
    return this.statService.getInfoStatByIdDi(_idDi, _idLogs);
  }

  @Query(() => Stat)
  getStatByIdlogs(@Args('_idDi') _idDi: string) {
    return this.statService.getStatByIdlogs(_idDi);
  }
  @Query(() => [Stat])
  async getRetourDataStats(@Args('_idDi') _idDi: string) {
    return await this.statService.getRetourDataStats(_idDi);
  }

  @Query(() => DiStatConsistencyReport)
  @UseGuards(JwtAuthGuard)
  async checkDiStatConsistency(
    @Args('limit', { nullable: true, type: () => Int }) limit?: number,
  ) {
    return await this.statService.checkDiStatConsistency(limit);
  }

  @Mutation(() => Stat)
  async addPauseLog(
    @Args('statId') statId: string,
    @Args('pauseLog') pauseLog: PauseLogInput,
  ): Promise<Stat> {
    return this.statService.addPauseLog(statId, pauseLog);
  }

  @Mutation(() => Stat)
  async updatePauseLog(
    @Args('statId') statId: string,
    @Args('pauseLogId') pauseLogId: string,
    @Args('updatedPauseTime') updatedPauseTime: UpdatedPauseTime,
  ): Promise<Stat> {
    return this.statService.updatePauseTime(
      statId,
      pauseLogId,
      updatedPauseTime,
    );
  }
}

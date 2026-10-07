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
  WorkTimer,
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
import { withErrorContext, reportCatchError } from '../common/error-context';

@Resolver(() => Stat)
export class StatResolver {
  private readonly logger = new Logger(StatResolver.name);

  constructor(
    private readonly statService: StatService,
    private readonly pubsub: PubSub,
  ) {}
  @Mutation(() => CreateStatNotificationReturn)
  async createStat(@Args('createStatInput') createStatInput: CreateStatInput) {
    try {
      this.pubsub.publish('you-got-notification-diagnostic', {
        notificationDiagnostic: {
          _idDi: createStatInput._idDi,
          messageNotification: createStatInput.notificationMessage,
          _idtechDiag: createStatInput.id_tech_diag,
        },
      });
      return await this.statService.createStat(createStatInput);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.createStat');
    }
  }

  @Subscription(() => CreateStatNotificationReturn)
  notificationDiagnostic() {
    try {
      return this.pubsub.asyncIterator('you-got-notification-diagnostic');
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.notificationDiagnostic');
    }
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
      reportCatchError(error, 'StatResolver.affectForRep');
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
    try {
      return this.pubsub.asyncIterator('you-got-notification-reparation');
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.notificationReparation');
    }
  }

  /**
   * 
  this function for pause time fired when user press on pause 
   */

  @Mutation(() => Boolean)
  async lapTimeForPauseAndGetBack(
    @Args('_id') _id: string,
    @Args('diagTime') diagTime: string,
  ) {
    try {
      const isUpdated = await this.statService.lapTime(_id, diagTime);
      return !!isUpdated;
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.lapTimeForPauseAndGetBack');
    }
  }

  @Mutation(() => Boolean)
  async lapTimeForPauseAndGetBackForReaparation(
    @Args('_id') _id: string,
    @Args('repTime') repTime: string,
  ) {
    try {
      const isUpdated = await this.statService.lapTimeForReaparation(_id, repTime);
      return !!isUpdated;
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.lapTimeForPauseAndGetBackForReaparation');
    }
  }

  /**
   * 
  this function will get last time pause to continue counting later 
   */
  /**
   * Chrono diag/réparation d'un Stat — SEULE source de l'affichage du compteur.
   * Le front ne reconstruit plus l'état depuis la ligne de liste, le cache
   * Apollo et localStorage : il affiche cet instantané.
   */
  @Query(() => WorkTimer)
  @UseGuards(JwtAuthGuard)
  async workTimer(@Args('statId') statId: string) {
    try {
      return await this.statService.getWorkTimer(statId);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.workTimer');
    }
  }

  @Query(() => Stat)
  async getLastPauseTime(@Args('_id') _id: string) {
    try {
      return await this.statService.getLastPauseTime(_id);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.getLastPauseTime');
    }
  }

  /**
   * 
   We gonna create method to save diagnostic when tech id finish his work,
   functions for get last pause time for reparation  and one for lap time pause and back for reapration 
   */

  // this one to get last time when he makes pause for reapartion
  @Query(() => Stat)
  async getLastPauseTimeforreaparation(@Args('_id') _id: string) {
    try {
      return await this.statService.getLastPauseTimeForReparation(_id);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.getLastPauseTimeforreaparation');
    }
  }

  @Query(() => StatsTableData)
  @UseGuards(JwtAuthGuard)
  async searchTechDI(
    @CurrentUser() profile: Profile,
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    @Args('search') search: SearchInput,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
  ) {
    try {
      // Convert the date strings to JavaScript Date objects if provided
      const start = startDate ? new Date(startDate) : undefined;
      const end = endDate ? new Date(endDate) : undefined;

      return await this.statService.searchTechDi(
        paginationConfig,
        search,
        profile._id,
        profile.role,
        start,
        end,
      );
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.searchTechDI');
    }
  }

  @Query(() => StatsTableData)
  @UseGuards(JwtAuthGuard)
  async getDiForTech(
    @CurrentUser() profile: Profile,
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
  ) {
    try {
      // Convert the date strings to JavaScript Date objects if provided
      const start = startDate ? new Date(startDate) : undefined;
      const end = endDate ? new Date(endDate) : undefined;

      return await this.statService.getDiForTech(
        paginationConfig,
        profile._id,
        profile.role,
        start,
        end,
      );
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.getDiForTech');
    }
  }

  @Query(() => [StatsCount])
  @UseGuards(JwtAuthGuard)
  async getDiStatusCounts(
    @CurrentUser() tech: Profile,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
  ) {
    try {
      // Convert the date strings to JavaScript Date objects if provided
      const start = startDate ? new Date(startDate) : undefined;
      const end = endDate ? new Date(endDate) : undefined;

      return await this.statService.getDiStatusCounts(tech._id, start, end);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.getDiStatusCounts');
    }
  }

  @Query(() => Stat)
  async getStatbyID(@Args('_idSTAT') _idSTAT: string) {
    try {
      return await this.statService.getDIByStat(_idSTAT);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.getStatbyID');
    }
  }

  @Query(() => DiReparationInfo)
  async getStatInfoForTechReparation(@Args('_idDi') _idDi: string) {
    try {
      const value = await this.statService.getStatInfoForTechReparation(_idDi);

      return value;
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.getStatInfoForTechReparation');
    }
  }

  // NULLABLE : une DI peut n'avoir aucun `Stat` pour le cycle demandé (aucun
  // technicien affecté). Auparavant la requête retombait sur le Stat d'un autre
  // cycle ; elle renvoie désormais `null`, ce que le type doit autoriser.
  @Query(() => Stat, { nullable: true })
  async getInfoStatByIdDi(
    @Args('_idDi') _idDi: string,
    @Args('_idLogs', { nullable: true }) _idLogs: number,
  ) {
    try {
      return await this.statService.getInfoStatByIdDi(_idDi, _idLogs);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.getInfoStatByIdDi');
    }
  }

  // Nullable : une DI pas encore affectée à un technicien (CREATED, PENDING1)
  // n'a AUCUN Stat — état normal, pas une erreur.
  @Query(() => Stat, { nullable: true })
  async getStatByIdlogs(@Args('_idDi') _idDi: string) {
    try {
      return await this.statService.getStatByIdlogs(_idDi);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.getStatByIdlogs');
    }
  }
  @Query(() => [Stat])
  async getRetourDataStats(@Args('_idDi') _idDi: string) {
    try {
      return await this.statService.getRetourDataStats(_idDi);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.getRetourDataStats');
    }
  }

  @Query(() => DiStatConsistencyReport)
  @UseGuards(JwtAuthGuard)
  async checkDiStatConsistency(
    @Args('limit', { nullable: true, type: () => Int }) limit?: number,
  ) {
    try {
      return await this.statService.checkDiStatConsistency(limit);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.checkDiStatConsistency');
    }
  }

  @Mutation(() => Stat)
  async addPauseLog(
    @Args('statId') statId: string,
    @Args('pauseLog') pauseLog: PauseLogInput,
  ): Promise<Stat> {
    try {
      return await this.statService.addPauseLog(statId, pauseLog);
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.addPauseLog');
    }
  }

  @Mutation(() => Stat)
  async updatePauseLog(
    @Args('statId') statId: string,
    @Args('pauseLogId') pauseLogId: string,
    @Args('updatedPauseTime') updatedPauseTime: UpdatedPauseTime,
  ): Promise<Stat> {
    try {
      return await this.statService.updatePauseTime(
        statId,
        pauseLogId,
        updatedPauseTime,
      );
    } catch (error) {
      throw withErrorContext(error, 'StatResolver.updatePauseLog');
    }
  }
}

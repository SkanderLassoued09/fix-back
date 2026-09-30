import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { LogsDiService } from './logs-di.service';
import { LogsDi } from './entities/logs-di.entity';
import { UpdateLogsDiInput } from './dto/update-logs-di.input';
import { ComposantStructureInput } from 'src/di/dto/create-di.input';
import { DiagUpdateLogs } from './dto/create-logs-di.input';
import { withErrorContext } from '../common/error-context';

@Resolver(() => LogsDi)
export class LogsDiResolver {
  constructor(private readonly logsDiService: LogsDiService) {}

  @Mutation(() => LogsDi)
  async createLogsDi(@Args('_id') _id: string, @Args('_idDi') _idDi: number) {
    try {
      return await this.logsDiService.create(_id, _idDi);
    } catch (error) {
      throw withErrorContext(error, 'LogsDiResolver.createLogsDi');
    }
  }

  @Mutation(() => LogsDi)
  async tech_startDiagnosticLogs(
    @Args('_id') _id: string,
    @Args('_idDi') _idDi: number,
    @Args('diag') diag: DiagUpdateLogs,
  ) {
    try {
      return await this.logsDiService.tech_startDiagnostic(_id, _idDi, diag);
    } catch (error) {
      throw withErrorContext(error, 'LogsDiResolver.tech_startDiagnosticLogs');
    }
  }

  @Query(() => [LogsDi], { name: 'logsDi' })
  findAll() {
    try {
      return this.logsDiService.findAll();
    } catch (error) {
      throw withErrorContext(error, 'LogsDiResolver.findAll');
    }
  }

  @Query(() => LogsDi)
  async getLigsById(
    @Args('id') id: string,
    @Args('_idDi', { type: () => Int }) _idDi: number,
  ) {
    try {
      return await this.logsDiService.getLogsById(_idDi, id);
    } catch (error) {
      throw withErrorContext(error, 'LogsDiResolver.getLigsById');
    }
  }

  @Query(() => [LogsDi])
  async getAllLogsByDi(@Args('_idDi') _idDi: string) {
    try {
      return await this.logsDiService.getAllLogsByDi(_idDi);
    } catch (error) {
      throw withErrorContext(error, 'LogsDiResolver.getAllLogsByDi');
    }
  }

  @Mutation(() => LogsDi)
  updateLogsDi(
    @Args('updateLogsDiInput') updateLogsDiInput: UpdateLogsDiInput,
  ) {
    try {
      return this.logsDiService.update(updateLogsDiInput.id, updateLogsDiInput);
    } catch (error) {
      throw withErrorContext(error, 'LogsDiResolver.updateLogsDi');
    }
  }

  @Mutation(() => LogsDi)
  removeLogsDi(@Args('id', { type: () => Int }) id: number) {
    try {
      return this.logsDiService.remove(id);
    } catch (error) {
      throw withErrorContext(error, 'LogsDiResolver.removeLogsDi');
    }
  }
}

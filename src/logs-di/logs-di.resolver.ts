import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { LogsDiService } from './logs-di.service';
import { LogsDi } from './entities/logs-di.entity';
import { UpdateLogsDiInput } from './dto/update-logs-di.input';
import { ComposantStructureInput } from 'src/di/dto/create-di.input';
import { DiagUpdateLogs } from './dto/create-logs-di.input';

@Resolver(() => LogsDi)
export class LogsDiResolver {
  constructor(private readonly logsDiService: LogsDiService) {}

  @Mutation(() => LogsDi)
  createLogsDi(@Args('_id') _id: string, @Args('_idDi') _idDi: number) {
    return this.logsDiService.create(_id, _idDi);
  }

  @Mutation(() => LogsDi)
  async tech_startDiagnosticLogs(
    @Args('_id') _id: string,
    @Args('_idDi') _idDi: number,
    @Args('diag') diag: DiagUpdateLogs,
  ) {
    return await this.logsDiService.tech_startDiagnostic(_id, _idDi, diag);
  }

  @Query(() => [LogsDi], { name: 'logsDi' })
  findAll() {
    return this.logsDiService.findAll();
  }

  @Query(() => LogsDi)
  getLigsById(
    @Args('id') id: string,
    @Args('_idDi', { type: () => Int }) _idDi: number,
  ) {
    return this.logsDiService.getLogsById(_idDi, id);
  }

  @Query(() => [LogsDi])
  getAllLogsByDi(@Args('_idDi') _idDi: string) {
    return this.logsDiService.getAllLogsByDi(_idDi);
  }

  @Mutation(() => LogsDi)
  updateLogsDi(
    @Args('updateLogsDiInput') updateLogsDiInput: UpdateLogsDiInput,
  ) {
    return this.logsDiService.update(updateLogsDiInput.id, updateLogsDiInput);
  }

  @Mutation(() => LogsDi)
  removeLogsDi(@Args('id', { type: () => Int }) id: number) {
    return this.logsDiService.remove(id);
  }
}

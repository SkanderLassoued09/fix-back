import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { StatsService } from './stats.service';
import { Stat } from './entities/stat.entity';
import { CreateStatInput } from './dto/create-stat.input';

@Resolver(() => Stat)
export class StatsResolver {
  constructor(private readonly statsService: StatsService) {}
  @Mutation(() => Stat)
  createStat(
    @Args('createStatInput')
    createStatInput: CreateStatInput,
  ) {
    return this.statsService.createStat(createStatInput);
  }
}

import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { StatService } from './stat.service';
import { Stat } from './entities/stat.entity';
import { CreateStatInput } from './dto/create-stat.input';
import { UpdateStatInput } from './dto/update-stat.input';

@Resolver(() => Stat)
export class StatResolver {
  constructor(private readonly statService: StatService) {}

  @Mutation(() => Stat)
  createStat(@Args('createStatInput') createStatInput: CreateStatInput) {
    return this.statService.createStat(createStatInput);
  }
}

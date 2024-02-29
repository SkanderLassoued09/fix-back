import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { DiService } from './di.service';
import { Di } from './entities/di.entity';
import { CreateDiInput } from './dto/create-di.input';

@Resolver(() => Di)
export class DiResolver {
  constructor(private readonly diService: DiService) {}

  @Mutation(() => Di)
  createDi(@Args('createDiInput') createDiInput: CreateDiInput) {
    return this.diService.create(createDiInput);
  }
}

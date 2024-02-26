import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { DiService } from './di.service';
import { Di } from './entities/di.entity';
import { CreateDiInput } from './dto/create-di.input';
import { UpdateDiInput } from './dto/update-di.input';

@Resolver(() => Di)
export class DiResolver {
  constructor(private readonly diService: DiService) {}

  @Mutation(() => Di)
  createDi(@Args('createDiInput') createDiInput: CreateDiInput) {
    return this.diService.create(createDiInput);
  }

  @Query(() => [Di], { name: 'di' })
  findAll() {
    return this.diService.findAll();
  }

  @Query(() => Di, { name: 'di' })
  findOne(@Args('id', { type: () => Int }) id: number) {
    return this.diService.findOne(id);
  }

  @Mutation(() => Di)
  updateDi(@Args('updateDiInput') updateDiInput: UpdateDiInput) {
    return this.diService.update(updateDiInput.id, updateDiInput);
  }

  @Mutation(() => Di)
  removeDi(@Args('id', { type: () => Int }) id: number) {
    return this.diService.remove(id);
  }
}

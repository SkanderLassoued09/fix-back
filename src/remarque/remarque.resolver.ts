import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { RemarqueService } from './remarque.service';
import { Remarque } from './entities/remarque.entity';
import { CreateRemarqueInput } from './dto/create-remarque.input';

@Resolver(() => Remarque)
export class RemarqueResolver {
  constructor(private readonly remarqueService: RemarqueService) {}

  @Mutation(() => Remarque)
  createRemarque(
    @Args('createRemarqueInput') createRemarqueInput: CreateRemarqueInput,
  ) {
    return this.remarqueService.create(createRemarqueInput);
  }

  @Query(() => [Remarque], { name: 'remarque' })
  findAll() {
    return this.remarqueService.findAll();
  }

  @Query(() => Remarque, { name: 'remarque' })
  findOne(@Args('id', { type: () => Int }) id: number) {
    return this.remarqueService.findOne(id);
  }

  @Mutation(() => Remarque)
  removeRemarque(@Args('id', { type: () => Int }) id: number) {
    return this.remarqueService.remove(id);
  }
}

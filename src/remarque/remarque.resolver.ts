import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { RemarqueService } from './remarque.service';
import { Remarque } from './entities/remarque.entity';
import { CreateRemarqueInput } from './dto/create-remarque.input';

@Resolver(() => Remarque)
export class RemarqueResolver {
  constructor(private readonly remarqueService: RemarqueService) {}

  @Mutation(() => Remarque)
  createRemarque(
    @Args('createRemarqueInput')
    createRemarqueInput: CreateRemarqueInput,
  ) {
    return this.remarqueService.createRemarque(createRemarqueInput);
  }
}

import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { RemarqueService } from './remarque.service';
import { Remarque } from './entities/remarque.entity';
import { CreateRemarqueInput } from './dto/create-remarque.input';
import { withErrorContext } from '../common/error-context';

@Resolver(() => Remarque)
export class RemarqueResolver {
  constructor(private readonly remarqueService: RemarqueService) {}

  @Mutation(() => Remarque)
  createRemarque(
    @Args('createRemarqueInput') createRemarqueInput: CreateRemarqueInput,
  ) {
    try {
      return this.remarqueService.create(createRemarqueInput);
    } catch (error) {
      throw withErrorContext(error, 'RemarqueResolver.createRemarque');
    }
  }

  @Query(() => [Remarque], { name: 'remarque' })
  findAll() {
    try {
      return this.remarqueService.findAll();
    } catch (error) {
      throw withErrorContext(error, 'RemarqueResolver.findAll');
    }
  }

  @Query(() => Remarque, { name: 'remarque' })
  findOne(@Args('id', { type: () => Int }) id: number) {
    try {
      return this.remarqueService.findOne(id);
    } catch (error) {
      throw withErrorContext(error, 'RemarqueResolver.findOne');
    }
  }

  @Mutation(() => Remarque)
  removeRemarque(@Args('id', { type: () => Int }) id: number) {
    try {
      return this.remarqueService.remove(id);
    } catch (error) {
      throw withErrorContext(error, 'RemarqueResolver.removeRemarque');
    }
  }
}

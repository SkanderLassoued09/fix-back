import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { ComposantService } from './composant.service';
import { Composant } from './entities/composant.entity';
import { CreateComposantInput } from './dto/create-composant.input';
import { UpdateComposantInput } from './dto/update-composant.input';

@Resolver(() => Composant)
export class ComposantResolver {
  constructor(private readonly composantService: ComposantService) {}

  @Mutation(() => Composant)
  createComposant(
    @Args('createComposantInput')
    createComposantInput: CreateComposantInput,
  ) {
    return this.composantService.createComposant(createComposantInput);
  }

  @Mutation(() => Boolean)
  removeComposant(@Args('_id') _id: string): Promise<Boolean> {
    try {
      return this.composantService.removeComposant(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete Composant');
    }
  }

  @Query(() => Composant)
  async findOneComposant(@Args('_id') _id: string): Promise<Composant> {
    return await this.composantService.findOneComposant(_id);
  }

  @Query(() => [Composant])
  async findAllComposant(): Promise<[Composant]> {
    return await this.composantService.findAllComposants();
  }
}

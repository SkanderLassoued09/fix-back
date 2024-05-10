import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { ComposantService } from './composant.service';
import { Composant } from './entities/composant.entity';
import {
  CreateComposantInput,
  UpdateComposantResponse,
} from './dto/create-composant.input';

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
  @Mutation(() => UpdateComposantResponse)
  async addComposantInfo(
    @Args('updateComposant') updateComposant: CreateComposantInput,
  ): Promise<UpdateComposantResponse> {
    try {
      const updatedEntity = await this.composantService.addComposantInfo(
        updateComposant,
      );
      if (updatedEntity) {
        return updatedEntity;
      }
    } catch (error) {
      throw new Error('Failed to update composant: ' + error.message);
    }
  }

  @Query(() => Composant)
  async findOneComposant(@Args('name') name: string): Promise<Composant> {
    return await this.composantService.findOneComposant(name);
  }

  @Query(() => [Composant])
  async findAllComposant(): Promise<[Composant]> {
    return await this.composantService.findAllComposants();
  }
}

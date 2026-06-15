import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { ComposantService } from './composant.service';
import { Composant } from './entities/composant.entity';
import {
  CreateComposantInput,
  UpdateComposantResponse,
} from './dto/create-composant.input';
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

  @Mutation(() => Composant)
  async removeComposant(@Args('_id') _id: string): Promise<Composant> {
    return await this.composantService.removeComposant(_id);
  }

  @Mutation(() => UpdateComposantResponse)
  async updateComposant(
    @Args('updateComposant') updateComposant: CreateComposantInput,
  ): Promise<UpdateComposantResponse> {
    return await this.composantService.updateComposant(updateComposant);
  }

  /**
   * Partial update — only `_id` is required, every other field is
   * optional. Used by reassignment flows that need to change a single
   * column (e.g. component category) without re-sending the full row.
   */
  @Mutation(() => UpdateComposantResponse)
  async updateComposantPartial(
    @Args('updateComposantInput') updateComposantInput: UpdateComposantInput,
  ): Promise<UpdateComposantResponse> {
    return (await this.composantService.updateComposantPartial(
      updateComposantInput,
    )) as unknown as UpdateComposantResponse;
  }
  @Mutation(() => UpdateComposantResponse)
  async addComposantInfo(
    @Args('updateComposant') updateComposant: CreateComposantInput,
  ): Promise<UpdateComposantResponse> {
    // The service always returns the updated doc or throws a clean error
    // (NOT_FOUND when no row matches). Don't wrap it in a generic Error — that
    // erased the code and turned an expected 404 into a 500. Don't return
    // undefined either: the field is non-nullable.
    return await this.composantService.addComposantInfo(updateComposant);
  }

  @Query(() => Composant)
  async findOneComposant(@Args('name') name: string): Promise<Composant> {
    return await this.composantService.findOneComposant(name);
  }

  @Query(() => [Composant])
  async findAllComposant(): Promise<[Composant]> {
    return await this.composantService.findAllComposants();
  }

  @Query(() => [Composant])
  async searchComposants(@Args('name') name: string): Promise<any> {
    return await this.composantService.searchComposants(name);
  }
}

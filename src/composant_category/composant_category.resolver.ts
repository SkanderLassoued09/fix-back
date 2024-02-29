import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { Composant_Category } from './entities/composant_category.entity';
import { CreateComposant_CategoryInput } from './dto/create-composant_category.input';
import { Composant_CategoryService } from './composant_category.service';

@Resolver(() => Composant_Category)
export class Composant_CategoryResolver {
  constructor(
    private readonly composant_CategoryService: Composant_CategoryService,
  ) {}

  @Mutation(() => Composant_Category)
  createComposant_Category(
    @Args('createComposant_CategoryInput')
    createComposant_CategoryInput: CreateComposant_CategoryInput,
  ) {
    return this.composant_CategoryService.createComposant_Category(
      createComposant_CategoryInput,
    );
  }

  @Mutation(() => Boolean)
  removeComposant_Category(@Args('_id') _id: string): Promise<Boolean> {
    try {
      return this.composant_CategoryService.removeComposant_Category(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete Composant_Category');
    }
  }

  @Query(() => Composant_Category)
  async findOneComposant_Category(
    @Args('_id') _id: string,
  ): Promise<Composant_Category> {
    return await this.composant_CategoryService.findOneComposant_Category(_id);
  }

  @Query(() => [Composant_Category])
  async findAllComposant_Category(): Promise<[Composant_Category]> {
    return await this.composant_CategoryService.findAllComposant_Categorys();
  }
}

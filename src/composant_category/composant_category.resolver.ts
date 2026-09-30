import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { Composant_Category } from './entities/composant_category.entity';
import { CreateComposant_CategoryInput } from './dto/create-composant_category.input';
import { Composant_CategoryService } from './composant_category.service';
import { withErrorContext } from '../common/error-context';

@Resolver(() => Composant_Category)
export class Composant_CategoryResolver {
  constructor(
    private readonly composant_CategoryService: Composant_CategoryService,
  ) {}

  @Mutation(() => Composant_Category)
  async createComposant_Category(
    @Args('createComposant_CategoryInput')
    createComposant_CategoryInput: CreateComposant_CategoryInput,
  ) {
    try {
      const data =
        await this.composant_CategoryService.createComposant_Category(
          createComposant_CategoryInput,
        );

      return data;
    } catch (error) {
      throw withErrorContext(
        error,
        'Composant_CategoryResolver.createComposant_Category',
      );
    }
  }

  @Mutation(() => Composant_Category)
  async removeComposant_Category(
    @Args('_id') _id: string,
  ): Promise<Composant_Category> {
    try {
      return await this.composant_CategoryService.removeComposant_Category(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete Composant_Category');
    }
  }

  @Query(() => Composant_Category)
  async findOneComposant_Category(
    @Args('_id') _id: string,
  ): Promise<Composant_Category> {
    try {
      return await this.composant_CategoryService.findOneComposant_Category(
        _id,
      );
    } catch (error) {
      throw withErrorContext(
        error,
        'Composant_CategoryResolver.findOneComposant_Category',
      );
    }
  }

  @Query(() => [Composant_Category])
  async findAllComposant_Category(): Promise<Composant_Category[]> {
    try {
      return await this.composant_CategoryService.findAllComposant_Categorys();
    } catch (error) {
      throw withErrorContext(
        error,
        'Composant_CategoryResolver.findAllComposant_Category',
      );
    }
  }
}

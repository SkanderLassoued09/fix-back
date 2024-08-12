import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { DiCategoryService } from './di_category.service';
import { DiCategory } from './entities/di_category.entity';
import { CreateDiCategoryInput } from './dto/create-di_category.input';

@Resolver(() => DiCategory)
export class DiCategoryResolver {
  constructor(private readonly diCategoryService: DiCategoryService) {}

  @Mutation(() => DiCategory)
  createDiCategory(
    @Args('category')
    category: string,
  ) {
    return this.diCategoryService.createDiCategory(category);
  }

  @Mutation(() => Boolean)
  removeDiCategory(@Args('_id') _id: string): Promise<Boolean> {
    try {
      return this.diCategoryService.removeDiCategory(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete DiCategory');
    }
  }

  @Query(() => DiCategory)
  async findOneDiCategory(@Args('_id') _id: string): Promise<DiCategory> {
    return await this.diCategoryService.findOneDiCategory(_id);
  }

  @Query(() => [DiCategory])
  async findAllDiCategory(): Promise<DiCategory[]> {
    try {
      return await this.diCategoryService.findAllDiCategorys();
    } catch (error) {
      throw error;
    }
  }
}

import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { DiCategorieService } from './di_categorie.service';
import { DiCategorie } from './entities/di_categorie.entity';
import { CreateDiCategorieInput } from './dto/create-di_categorie.input';

@Resolver(() => DiCategorie)
export class DiCategorieResolver {
  constructor(private readonly diCategorieService: DiCategorieService) {}

  @Mutation(() => DiCategorie)
  createDiCategorie(
    @Args('createDiCategorieInput')
    createDiCategorieInput: CreateDiCategorieInput,
  ) {
    return this.diCategorieService.createDiCategorie(createDiCategorieInput);
  }

  @Mutation(() => Boolean)
  removeDiCategorie(@Args('_id') _id: string): Promise<Boolean> {
    try {
      return this.diCategorieService.removeDiCategorie(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete DiCategorie');
    }
  }

  @Query(() => DiCategorie)
  async findOneDiCategorie(@Args('_id') _id: string): Promise<DiCategorie> {
    return await this.diCategorieService.findOneDiCategorie(_id);
  }

  @Query(() => [DiCategorie])
  async findAllDiCategorie(): Promise<[DiCategorie]> {
    return await this.diCategorieService.findAllDiCategories();
  }
}

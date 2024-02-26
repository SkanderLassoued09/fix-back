import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { Composant_Categorie } from './entities/composant_categorie.entity';
import { CreateComposant_CategorieInput } from './dto/create-composant_categorie.input';
import { Composant_CategorieService } from './composant_categorie.service';

@Resolver(() => Composant_Categorie)
export class Composant_CategorieResolver {
  constructor(
    private readonly composant_CategorieService: Composant_CategorieService,
  ) {}

  @Mutation(() => Composant_Categorie)
  createComposant_Categorie(
    @Args('createComposant_CategorieInput')
    createComposant_CategorieInput: CreateComposant_CategorieInput,
  ) {
    return this.composant_CategorieService.createComposant_Categorie(
      createComposant_CategorieInput,
    );
  }

  @Mutation(() => Boolean)
  removeComposant_Categorie(@Args('_id') _id: string): Promise<Boolean> {
    try {
      return this.composant_CategorieService.removeComposant_Categorie(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete Composant_Categorie');
    }
  }

  @Query(() => Composant_Categorie)
  async findOneComposant_Categorie(
    @Args('_id') _id: string,
  ): Promise<Composant_Categorie> {
    return await this.composant_CategorieService.findOneComposant_Categorie(
      _id,
    );
  }

  @Query(() => [Composant_Categorie])
  async findAllComposant_Categorie(): Promise<[Composant_Categorie]> {
    return await this.composant_CategorieService.findAllComposant_Categories();
  }
}

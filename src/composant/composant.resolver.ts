import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { ComposantService } from './composant.service';
import { Composant } from './entities/composant.entity';
import {
  CreateComposantInput,
  UpdateComposantResponse,
} from './dto/create-composant.input';
import { UpdateComposantInput } from './dto/update-composant.input';
import {
  ComposantBrowseInput,
  ComposantCategoryNode,
  ComposantPage,
} from './dto/browse-composant.input';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { Profile } from 'src/profile/entities/profile.entity';
import { withErrorContext } from '../common/error-context';

@Resolver(() => Composant)
export class ComposantResolver {
  constructor(private readonly composantService: ComposantService) {}

  @Mutation(() => Composant)
  async createComposant(
    @Args('createComposantInput')
    createComposantInput: CreateComposantInput,
    // The Discord "catalog event" embed wants WHO created the part (tech name
    // / role) — pulled from the JWT via the existing CurrentUser decorator.
    // Optional: if no token (rare), the service falls back to "Auteur inconnu".
    @CurrentUser() profile: Profile,
  ) {
    try {
      return await this.composantService.createComposant(
        createComposantInput,
        profile,
      );
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.createComposant');
    }
  }

  @Mutation(() => Composant)
  async removeComposant(@Args('_id') _id: string): Promise<Composant> {
    try {
      return await this.composantService.removeComposant(_id);
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.removeComposant');
    }
  }

  @Mutation(() => UpdateComposantResponse)
  async updateComposant(
    @Args('updateComposant') updateComposant: CreateComposantInput,
  ): Promise<UpdateComposantResponse> {
    try {
      return await this.composantService.updateComposant(updateComposant);
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.updateComposant');
    }
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
    try {
      return (await this.composantService.updateComposantPartial(
        updateComposantInput,
      )) as unknown as UpdateComposantResponse;
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.updateComposantPartial');
    }
  }
  @Mutation(() => UpdateComposantResponse)
  async addComposantInfo(
    @Args('updateComposant') updateComposant: CreateComposantInput,
  ): Promise<UpdateComposantResponse> {
    try {
      // The service always returns the updated doc or throws a clean error
      // (NOT_FOUND when no row matches). Don't wrap it in a generic Error — that
      // erased the code and turned an expected 404 into a 500. Don't return
      // undefined either: the field is non-nullable.
      return await this.composantService.addComposantInfo(updateComposant);
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.addComposantInfo');
    }
  }

  @Query(() => Composant)
  async findOneComposant(@Args('name') name: string): Promise<Composant> {
    try {
      return await this.composantService.findOneComposant(name);
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.findOneComposant');
    }
  }

  @Query(() => [Composant])
  async findAllComposant(): Promise<[Composant]> {
    try {
      return await this.composantService.findAllComposants();
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.findAllComposant');
    }
  }

  @Query(() => [Composant])
  async searchComposants(@Args('name') name: string): Promise<any> {
    try {
      return await this.composantService.searchComposants(name);
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.searchComposants');
    }
  }

  /**
   * Picker de composants du modal diagnostic — page filtrée + paginée.
   * Sert AUSSI BIEN l'ouverture d'un nœud catégorie (lazy) que la recherche
   * profonde : c'est la même requête, seuls les arguments changent.
   */
  @Query(() => ComposantPage)
  async browseComposants(
    @Args('input') input: ComposantBrowseInput,
  ): Promise<ComposantPage> {
    try {
      return await this.composantService.browseComposants(input);
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.browseComposants');
    }
  }

  /**
   * Racines de l'arbre du picker : catégories + nombre de composants.
   * Inclut le nœud synthétique « Sans catégorie » quand des composants ne
   * pointent aucune catégorie connue.
   */
  @Query(() => [ComposantCategoryNode])
  async composantCategoryTree(): Promise<ComposantCategoryNode[]> {
    try {
      return await this.composantService.composantCategoryTree();
    } catch (error) {
      throw withErrorContext(error, 'ComposantResolver.composantCategoryTree');
    }
  }
}

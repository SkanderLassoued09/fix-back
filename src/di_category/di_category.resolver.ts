import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { Profile } from 'src/profile/entities/profile.entity';
import { NotificationService } from 'src/notifications/notification.service';
import { DiCategoryService } from './di_category.service';
import { DiCategory } from './entities/di_category.entity';

/**
 * Destinataires de la cloche quand une catégorie apparaît dans le référentiel.
 *
 * Vocabulaire HUMAIN volontairement : `toProfileRoles()` (role-mapping.ts) le
 * traduit vers les valeurs réellement stockées sur les profils — dont la
 * coquille figée `COORDIANTOR`. Écrire les valeurs d'enum ici les désalignerait
 * de la base au premier renommage.
 */
const CATEGORY_WATCHERS = [
  'Manager',
  'Admin_Manager',
  'Coordinator',
  'Admin_Tech',
];

@Resolver(() => DiCategory)
export class DiCategoryResolver {
  private readonly logger = new Logger('DiCategoryResolver');

  constructor(
    private readonly diCategoryService: DiCategoryService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Le référentiel est PARTAGÉ : une catégorie créée ici apparaît dans le
   * diagnostic de tout le monde. D'où les deux garde-fous ajoutés :
   *   - `JwtAuthGuard` — la mutation était ouverte à un client anonyme ;
   *   - l'ENCADREMENT est notifié, avec l'auteur, quand une catégorie est
   *     RÉELLEMENT créée (jamais sur un doublon, sinon la cloche sonnerait à
   *     chaque quasi-collision de libellé).
   */
  @Mutation(() => DiCategory)
  @UseGuards(JwtAuthGuard)
  async createDiCategory(
    @Args('category')
    category: string,
    @CurrentUser() profile: Profile,
  ): Promise<DiCategory> {
    const { doc, created } = await this.diCategoryService.createDiCategory(
      category,
    );

    if (created) {
      // Best-effort : une notification qui échoue ne doit JAMAIS annuler la
      // création — même convention que les ~14 appels d'`emit` existants.
      try {
        await this.notificationService.emit({
          type: 'DI_CATEGORY_CREATED',
          diId: null, // une catégorie n'est pas une DI
          actorId: (profile as any)?._id ?? null,
          actorRole: (profile as any)?.role ?? null,
          message: `Nouvelle catégorie de diagnostic « ${doc.category} » créée`,
          payload: { categoryId: doc._id, category: doc.category },
          notify: { roles: CATEGORY_WATCHERS },
        });
      } catch (err) {
        this.logger.warn(
          `emit DI_CATEGORY_CREATED a échoué (${doc._id}) : ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }

    // `created` est un champ de RÉPONSE : il n'est pas sur le document, on le
    // recolle sur l'objet renvoyé. `toObject()` n'existe pas sur un lean/plain,
    // d'où le repli.
    const plain = (doc as any)?.toObject?.() ?? doc;
    return { ...plain, created };
  }

  @Mutation(() => DiCategory)
  removeDiCategory(@Args('_id') _id: string): Promise<DiCategory> {
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

import { InputType, Field, ObjectType, Int } from '@nestjs/graphql';
import { Composant } from '../entities/composant.entity';

/**
 * Entrée UNIQUE du picker de composants (modal diagnostic).
 *
 * La même requête sert les DEUX usages de l'arbre :
 *   - navigation : `categoryId` seul → la page de composants d'une catégorie,
 *     chargée à l'ouverture du nœud (lazy) ;
 *   - recherche profonde : `search` seul → toutes catégories confondues.
 *
 * Les deux peuvent se combiner (recherche restreinte à une catégorie).
 *
 * Convention de pagination alignée sur `PaginationConfigProfile`
 * (`src/profile/dto/create-profile.input.ts`) : `{ rows, first }` en entrée,
 * `{ xxxRecord, totalXxxCount }` en sortie.
 */
@InputType()
export class ComposantBrowseInput {
  /**
   * `_id` de catégorie (`C_Composant<N>`), ou la sentinelle
   * `__uncategorized__` pour le bucket « Sans catégorie ».
   * Absent → toutes catégories.
   */
  @Field({ nullable: true })
  categoryId?: string;

  /** Terme de recherche sur `name`. Ignoré en dessous de 2 caractères. */
  @Field({ nullable: true })
  search?: string;

  /** Taille de page. Borné côté service (1..200). */
  @Field(() => Int, { defaultValue: 50 })
  rows?: number;

  /** Index du premier élément (offset). */
  @Field(() => Int, { defaultValue: 0 })
  first?: number;
}

/**
 * Page de composants. `totalComposantCount` est le total APRÈS filtrage —
 * c'est lui qui dit à l'arbre s'il reste des enfants à charger.
 */
@ObjectType()
export class ComposantPage {
  @Field(() => [Composant])
  composantRecord: Composant[];

  @Field(() => Int)
  totalComposantCount: number;
}

/**
 * Nœud racine de l'arbre : une catégorie + le nombre de composants qu'elle
 * contient. `composantCount === 0` → la catégorie est une feuille (pas de
 * flèche d'expansion).
 */
@ObjectType()
export class ComposantCategoryNode {
  @Field()
  _id: string;

  @Field()
  category_composant: string;

  @Field(() => Int)
  composantCount: number;
}

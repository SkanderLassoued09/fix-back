import { InputType, Field } from '@nestjs/graphql';

/**
 * Entrée de l'ABANDON d'un diagnostic par un technicien. `motif` est un CODE
 * d'une liste blanche serveur (`DiService.ABANDON_MOTIFS`) ; « AUTRE » exige
 * `motifAutre` (texte libre non vide). L'auteur de l'abandon vient de
 * `@CurrentUser` (jamais du front).
 */
@InputType()
export class AbandonDiInput {
  @Field()
  diId: string;

  @Field()
  motif: string;

  @Field({ nullable: true })
  motifAutre?: string;
}

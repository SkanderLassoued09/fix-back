import { InputType, Field } from '@nestjs/graphql';

/**
 * Entrée de l'annulation d'une DI (bouton coordinateur, confirmé par mot de
 * passe). Le `password` est vérifié CÔTÉ SERVEUR contre le hash de
 * l'utilisateur courant (`@CurrentUser`) puis jeté — jamais stocké ni loggué.
 * `motif` est un CODE d'une liste blanche serveur ; « AUTRE » exige `motifAutre`
 * (texte libre non vide). `commentaire` reste optionnel.
 */
@InputType()
export class AnnulerDiInput {
  @Field()
  diId: string;

  @Field()
  parClient: boolean;

  @Field()
  motif: string;

  @Field({ nullable: true })
  motifAutre?: string;

  @Field({ nullable: true })
  commentaire?: string;

  @Field()
  password: string;
}

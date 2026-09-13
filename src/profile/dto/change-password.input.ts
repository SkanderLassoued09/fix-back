import { Field, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Changement de mot de passe par l'utilisateur LUI-MÊME.
 *
 * Volontairement SANS `_id` ni `username` : l'identité de l'acteur est prise
 * exclusivement dans le JWT (`@CurrentUser`). Accepter un identifiant fourni par
 * le client transformerait cette mutation en primitive de prise de contrôle de
 * compte — n'importe qui pourrait réécrire le mot de passe d'un autre.
 *
 * Les deux valeurs sont vérifiées côté serveur puis JETÉES : jamais stockées en
 * clair, jamais journalisées, jamais renvoyées (la mutation retourne un booléen).
 * Même règle que `AnnulerDiInput`.
 */
@InputType()
export class ChangePasswordInput {
  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Le mot de passe actuel est obligatoire.' })
  currentPassword: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Le nouveau mot de passe est obligatoire.' })
  // Aucune politique n'existait dans le dépôt : 8 caractères est le plancher
  // retenu. Elle ne s'applique QU'AUX nouveaux mots de passe — les comptes
  // existants continuent de se connecter avec le leur, si court soit-il.
  @MinLength(8, {
    message: 'Le nouveau mot de passe doit contenir au moins 8 caractères.',
  })
  // Borne haute : bcrypt ignore silencieusement les octets au-delà de 72, un
  // mot de passe plus long donnerait donc une fausse impression de robustesse.
  @MaxLength(72, {
    message: 'Le nouveau mot de passe ne peut pas dépasser 72 caractères.',
  })
  newPassword: string;
}

import { ObjectType, Field } from '@nestjs/graphql';

/**
 * Projection GraphQL en LECTURE SEULE d'une entrée `driveDocs`
 * (BC / Devis / BL / Facture / Image). Expose le VRAI nom du fichier téléversé
 * pour que l'UI l'affiche à la place d'un libellé générique. Dérivée de la map
 * Mongo `driveDocs` — jamais écrite directement.
 *
 * POURQUOI ICI et non dans `di.entity.ts` : `di.entity.ts` importe déjà
 * `LogsDi`, or la ligne de cycle expose désormais elle aussi ses `documents`.
 * Un import retour `logs-di.entity.ts → di.entity.ts` créerait un CYCLE
 * d'imports qui, avec les décorateurs, ne casse pas à la compilation mais à
 * l'exécution (le type résout `undefined` au moment où le décorateur s'évalue).
 * Ce module neutre est importé par les deux entités, sans cycle possible.
 */
@ObjectType()
export class DriveDoc {
  @Field()
  type: string;
  @Field({ nullable: true })
  name: string;
  @Field({ nullable: true })
  webViewLink: string;
}

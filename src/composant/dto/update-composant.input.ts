import { InputType, Field } from '@nestjs/graphql';

/**
 * Partial-update DTO for components. Only `_id` is required; every other
 * field is optional. The composant service strips `undefined` keys before
 * `$set`, so a request that supplies only `{ _id, category_composant_id }`
 * does NOT clear name/package/etc. — it touches only the listed fields.
 *
 * Use this for reassignment flows (changing the category, status, etc.)
 * from admin tools. The original `updateComposant(CreateComposantInput)`
 * mutation is kept for backward compatibility with the composant
 * management screen.
 */
@InputType()
export class UpdateComposantInput {
  @Field()
  _id: string;
  @Field({ nullable: true })
  name?: string;
  @Field({ nullable: true })
  package?: string;
  @Field({ nullable: true })
  category_composant_id?: string;
  @Field({ nullable: true })
  prix_achat?: number;
  @Field({ nullable: true })
  prix_vente?: number;
  @Field({ nullable: true })
  coming_date?: string;
  @Field({ nullable: true })
  link?: string;
  @Field({ nullable: true })
  quantity_stocked?: number;
  @Field({ nullable: true })
  pdf?: string;
  @Field({ nullable: true })
  status_composant?: string;
}

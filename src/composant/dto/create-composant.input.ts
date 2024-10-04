import { InputType, Field, ObjectType } from '@nestjs/graphql';

@InputType()
export class CreateComposantInput {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  name: string;
  @Field({ nullable: true })
  package: string;
  //the entity category composant
  @Field({ nullable: true })
  category_composant_id: string;
  @Field({ nullable: true })
  prix_achat: number;
  @Field({ nullable: true })
  prix_vente: number;
  @Field({ nullable: true })
  coming_date: string;
  @Field({ nullable: true })
  link: string;
  @Field({ nullable: true })
  quantity_stocked: number;
  @Field({ nullable: true })
  pdf: string;
  @Field({ nullable: true })
  status_composant: string;
}
@ObjectType()
export class UpdateComposantResponse {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  name: string;
  @Field({ nullable: true })
  package: string;
  //the entity category composant
  @Field({ nullable: true })
  category_composant_id: string;
  @Field({ nullable: true })
  prix_achat: number;
  @Field({ nullable: true })
  prix_vente: number;
  @Field({ nullable: true })
  coming_date: string;
  @Field({ nullable: true })
  link: string;
  @Field({ nullable: true })
  quantity_stocked: number;
  @Field({ nullable: true })
  pdf: string;
  @Field({ nullable: true })
  status_composant: string;
}

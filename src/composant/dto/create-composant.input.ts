import { InputType, Field } from '@nestjs/graphql';
import { IsDate } from 'class-validator';

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
  status: string;
}

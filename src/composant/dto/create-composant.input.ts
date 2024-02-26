import { InputType, Int, Field } from '@nestjs/graphql';
import { IsDate } from 'class-validator';

@InputType()
export class CreateComposantInput {
  @Field()
  _id: string;
  @Field()
  name: string;
  @Field()
  package: string;
  //the entity categorie composant
  @Field()
  categorie_id: string;
  @Field()
  prix_achat: number;
  @Field()
  prix_vente: number;
  @Field({ nullable: true })
  @IsDate()
  coming_date: Date;
  @Field({ nullable: true })
  link: string;
  @Field({ nullable: true })
  quantity_stocked: number;
  @Field({ nullable: true })
  pdf: string;
  @Field()
  status: string;
}

import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateComposant_CategorieInput {
  @Field()
  _id: string;
  @Field()
  categorie_composant: string;
}

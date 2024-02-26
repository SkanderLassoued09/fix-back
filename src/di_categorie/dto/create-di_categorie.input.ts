import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateDiCategorieInput {
  @Field()
  _id: string;
  @Field()
  categorie_DI: string;
}

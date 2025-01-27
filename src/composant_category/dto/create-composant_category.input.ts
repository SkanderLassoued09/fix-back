import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateComposant_CategoryInput {
  @Field({ nullable: true })
  _id: string;
  @Field()
  category_composant: string;
}

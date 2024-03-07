import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class CreateDiCategoryInput {
  @Field()
  _id: string;
  @Field()
  category_Di: string;
}

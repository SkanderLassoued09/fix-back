import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class CreateDiCategoryInput {
  @Field()
  _id: string;
  @Field({ nullable: true })
  category_DI: string;
}

import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class CreateDiCategoryInput {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  category: string;
}

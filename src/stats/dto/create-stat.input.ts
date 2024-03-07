import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateStatInput {
  @Field()
  _id: string;
}

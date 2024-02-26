import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateDiInput {
  @Field(() => Int, { description: 'Example field (placeholder)' })
  exampleField: number;
}

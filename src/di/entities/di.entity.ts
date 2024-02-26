import { ObjectType, Field, Int } from '@nestjs/graphql';

@ObjectType()
export class Di {
  @Field(() => Int, { description: 'Example field (placeholder)' })
  exampleField: number;
}

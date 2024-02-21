import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateEmplacementInput {
  @Field()
  _id: string;
  @Field()
  emplacement_name: string;
  @Field(() => Int, { nullable: true })
  emplacement_number: number;
  @Field(() => Int, { nullable: true })
  max_capacity: number;
  @Field(() => Int, { nullable: true })
  current_items: number;
  @Field()
  avaible: boolean;
}

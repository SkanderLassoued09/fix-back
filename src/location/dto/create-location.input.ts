import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateLocationInput {
  @Field()
  _id: string;
  @Field()
  location_name: string;
  @Field(() => Int, { nullable: true })
  location_number: number;
  @Field(() => Int, { nullable: true })
  max_capacity: number;
  @Field(() => Int, { nullable: true })
  current_item_stored: number;
  @Field({ defaultValue: true })
  avaible: boolean;
}

import { CreateStatInput } from './create-stat.input';
import { InputType, Field, Int, PartialType } from '@nestjs/graphql';

@InputType()
export class UpdateStatInput extends PartialType(CreateStatInput) {
  @Field(() => Int)
  id: number;
}

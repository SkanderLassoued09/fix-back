import { CreateDiInput } from './create-di.input';
import { InputType, Field, Int, PartialType } from '@nestjs/graphql';

@InputType()
export class UpdateDiInput extends PartialType(CreateDiInput) {
  @Field(() => Int)
  id: number;
}

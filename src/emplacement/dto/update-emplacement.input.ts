import { CreateEmplacementInput } from './create-emplacement.input';
import { InputType, Field, Int, PartialType } from '@nestjs/graphql';

@InputType()
export class UpdateEmplacementInput extends PartialType(CreateEmplacementInput) {
  @Field(() => Int)
  id: number;
}

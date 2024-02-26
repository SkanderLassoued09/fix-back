import { CreateComposantInput } from './create-composant.input';
import { InputType, Field, Int, PartialType } from '@nestjs/graphql';

@InputType()
export class UpdateComposantInput extends PartialType(CreateComposantInput) {
  @Field(() => Int)
  id: number;
}

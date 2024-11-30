import { CreateLogsDiInput } from './create-logs-di.input';
import { InputType, Field, Int, PartialType } from '@nestjs/graphql';

@InputType()
export class UpdateLogsDiInput extends PartialType(CreateLogsDiInput) {
  @Field(() => Int)
  id: number;
}

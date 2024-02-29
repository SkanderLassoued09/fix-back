import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class CreateTarifInput {
  @Field()
  tarif: number;
}

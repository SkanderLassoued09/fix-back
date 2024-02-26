import { InputType, Field, Int, PartialType } from '@nestjs/graphql';
import { CreateCompanieInput } from './create-company.input';

@InputType()
export class UpdateCompanyInput extends PartialType(CreateCompanieInput) {
  @Field(() => Int)
  id: number;
}

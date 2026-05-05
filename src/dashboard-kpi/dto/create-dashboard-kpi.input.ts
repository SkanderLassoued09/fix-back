import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateDashboardKpiInput {
  @Field(() => Int, { description: 'Example field (placeholder)' })
  exampleField: number;
}

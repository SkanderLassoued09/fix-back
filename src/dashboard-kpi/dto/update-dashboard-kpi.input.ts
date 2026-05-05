import { CreateDashboardKpiInput } from './create-dashboard-kpi.input';
import { InputType, Field, Int, PartialType } from '@nestjs/graphql';

@InputType()
export class UpdateDashboardKpiInput extends PartialType(CreateDashboardKpiInput) {
  @Field(() => Int)
  id: number;
}

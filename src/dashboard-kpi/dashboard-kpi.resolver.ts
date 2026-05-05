import { Resolver, Query, Args } from '@nestjs/graphql';
import { DashboardKpiService } from './dashboard-kpi.service';
import { DashboardKpi } from './entities/dashboard-kpi.entity';

@Resolver(() => DashboardKpi)
export class DashboardKpiResolver {
  constructor(private readonly dashboardKpiService: DashboardKpiService) {}

  @Query(() => DashboardKpi)
  async dashboardKpi(
    @Args('startDate', { nullable: true }) startDate: Date,
    @Args('endDate', { nullable: true }) endDate: Date,
  ) {
    return await this.dashboardKpiService.getDashboardOverview(
      startDate,
      endDate,
    );
  }
}

import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { DashboardKpiService } from './dashboard-kpi.service';
import {
  CategorySlice,
  DashboardKpi,
  FinanceTrendPoint,
  TechLeaderRow,
  TrendGranularity,
  TrendPoint,
} from './entities/dashboard-kpi.entity';
import { TechAnalyticsService } from './tech-analytics.service';
import { withErrorContext } from '../common/error-context';

/**
 * All dashboard reads. Every query accepts the same optional startDate/endDate
 * shape so the FE period filter drives them uniformly. Range arguments are
 * passed as ISO strings (matches the existing FilterConfigDi convention).
 */
@Resolver(() => DashboardKpi)
export class DashboardKpiResolver {
  constructor(
    private readonly dashboardKpiService: DashboardKpiService,
    private readonly techAnalyticsService: TechAnalyticsService,
  ) {}

  @Query(() => DashboardKpi)
  async dashboardKpi(
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
  ) {
    try {
      return await this.dashboardKpiService.getDashboardOverview(
        startDate,
        endDate,
      );
    } catch (error) {
      throw withErrorContext(error, 'DashboardKpiResolver.dashboardKpi');
    }
  }

  @Query(() => [TrendPoint])
  async dashboardTrend(
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('granularity', { type: () => TrendGranularity, nullable: true })
    granularity?: TrendGranularity,
  ): Promise<TrendPoint[]> {
    try {
      return await this.dashboardKpiService.getTrend(
        startDate,
        endDate,
        granularity ?? TrendGranularity.WEEK,
      );
    } catch (error) {
      throw withErrorContext(error, 'DashboardKpiResolver.dashboardTrend');
    }
  }

  @Query(() => [CategorySlice])
  async dashboardCategories(
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
  ): Promise<CategorySlice[]> {
    try {
      return await this.dashboardKpiService.getDiByCategory(startDate, endDate);
    } catch (error) {
      throw withErrorContext(error, 'DashboardKpiResolver.dashboardCategories');
    }
  }

  @Query(() => [FinanceTrendPoint])
  async dashboardFinanceTrend(
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('granularity', { type: () => TrendGranularity, nullable: true })
    granularity?: TrendGranularity,
  ): Promise<FinanceTrendPoint[]> {
    try {
      return await this.dashboardKpiService.getFinanceTrend(
        startDate,
        endDate,
        granularity ?? TrendGranularity.MONTH,
      );
    } catch (error) {
      throw withErrorContext(
        error,
        'DashboardKpiResolver.dashboardFinanceTrend',
      );
    }
  }

  @Query(() => [TechLeaderRow])
  async dashboardTechLeaderboard(
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<TechLeaderRow[]> {
    try {
      return await this.techAnalyticsService.getTechLeaderboard(
        startDate,
        endDate,
        limit ?? 20,
      );
    } catch (error) {
      throw withErrorContext(
        error,
        'DashboardKpiResolver.dashboardTechLeaderboard',
      );
    }
  }
}

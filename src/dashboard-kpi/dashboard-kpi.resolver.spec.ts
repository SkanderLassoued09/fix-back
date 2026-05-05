import { Test, TestingModule } from '@nestjs/testing';
import { DashboardKpiResolver } from './dashboard-kpi.resolver';
import { DashboardKpiService } from './dashboard-kpi.service';

describe('DashboardKpiResolver', () => {
  let resolver: DashboardKpiResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DashboardKpiResolver, DashboardKpiService],
    }).compile();

    resolver = module.get<DashboardKpiResolver>(DashboardKpiResolver);
  });

  it('should be defined', () => {
    expect(resolver).toBeDefined();
  });
});

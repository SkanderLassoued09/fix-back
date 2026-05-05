import { Test, TestingModule } from '@nestjs/testing';
import { DashboardKpiService } from './dashboard-kpi.service';

describe('DashboardKpiService', () => {
  let service: DashboardKpiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DashboardKpiService],
    }).compile();

    service = module.get<DashboardKpiService>(DashboardKpiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { LogsDiService } from './logs-di.service';

describe('LogsDiService', () => {
  let service: LogsDiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LogsDiService],
    }).compile();

    service = module.get<LogsDiService>(LogsDiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

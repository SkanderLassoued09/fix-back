import { Test, TestingModule } from '@nestjs/testing';
import { LogsDiResolver } from './logs-di.resolver';
import { LogsDiService } from './logs-di.service';

describe('LogsDiResolver', () => {
  let resolver: LogsDiResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LogsDiResolver, LogsDiService],
    }).compile();

    resolver = module.get<LogsDiResolver>(LogsDiResolver);
  });

  it('should be defined', () => {
    expect(resolver).toBeDefined();
  });
});

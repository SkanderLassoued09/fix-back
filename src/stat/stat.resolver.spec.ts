import { Test, TestingModule } from '@nestjs/testing';
import { StatResolver } from './stat.resolver';
import { StatService } from './stat.service';

describe('StatResolver', () => {
  let resolver: StatResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StatResolver, StatService],
    }).compile();

    resolver = module.get<StatResolver>(StatResolver);
  });

  it('should be defined', () => {
    expect(resolver).toBeDefined();
  });
});

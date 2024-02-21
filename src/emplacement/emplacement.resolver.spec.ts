import { Test, TestingModule } from '@nestjs/testing';
import { EmplacementResolver } from './emplacement.resolver';
import { EmplacementService } from './emplacement.service';

describe('EmplacementResolver', () => {
  let resolver: EmplacementResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EmplacementResolver, EmplacementService],
    }).compile();

    resolver = module.get<EmplacementResolver>(EmplacementResolver);
  });

  it('should be defined', () => {
    expect(resolver).toBeDefined();
  });
});

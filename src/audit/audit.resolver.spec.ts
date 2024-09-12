import { Test, TestingModule } from '@nestjs/testing';
import { AuditResolver } from './audit.resolver';
import { AuditService } from './audit.service';

describe('AuditResolver', () => {
  let resolver: AuditResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditResolver, AuditService],
    }).compile();

    resolver = module.get<AuditResolver>(AuditResolver);
  });

  it('should be defined', () => {
    expect(resolver).toBeDefined();
  });
});

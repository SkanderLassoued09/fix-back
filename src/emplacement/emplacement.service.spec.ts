import { Test, TestingModule } from '@nestjs/testing';
import { EmplacementService } from './emplacement.service';

describe('EmplacementService', () => {
  let service: EmplacementService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EmplacementService],
    }).compile();

    service = module.get<EmplacementService>(EmplacementService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

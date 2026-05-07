import { Test, TestingModule } from '@nestjs/testing';
import { DiscordHookService } from './discord-hook.service';

describe('DiscordHookService', () => {
  let service: DiscordHookService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscordHookService],
    }).compile();

    service = module.get<DiscordHookService>(DiscordHookService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

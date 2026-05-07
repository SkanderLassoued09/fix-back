import { Test, TestingModule } from '@nestjs/testing';
import { DiscordHookController } from './discord-hook.controller';
import { DiscordHookService } from './discord-hook.service';

describe('DiscordHookController', () => {
  let controller: DiscordHookController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiscordHookController],
      providers: [DiscordHookService],
    }).compile();

    controller = module.get<DiscordHookController>(DiscordHookController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

import { Module } from '@nestjs/common';
import { DiscordHookService } from './discord-hook.service';
import { DiscordHookController } from './discord-hook.controller';

@Module({
  controllers: [DiscordHookController],
  providers: [DiscordHookService]
})
export class DiscordHookModule {}

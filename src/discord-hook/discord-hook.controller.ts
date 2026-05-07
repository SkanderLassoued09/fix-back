import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { DiscordHookService } from './discord-hook.service';

@Controller('discord-hook')
export class DiscordHookController {
  constructor(private readonly discordHookService: DiscordHookService) {}
  @Post('test')
  async test(@Body('message') message: string) {
    // await this.discordHookService.sendMessage(
    //   message || '🚀 Default test message',
    // );
    // return { message: 'Notification sent to Discord' };
  }
}

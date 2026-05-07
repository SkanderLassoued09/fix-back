import { PartialType } from '@nestjs/mapped-types';
import { CreateDiscordHookDto } from './create-discord-hook.dto';

export class UpdateDiscordHookDto extends PartialType(CreateDiscordHookDto) {}

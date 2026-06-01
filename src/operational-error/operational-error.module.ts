import { Module } from '@nestjs/common';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import { OperationalErrorService } from './operational-error.service';

/**
 * Cross-cutting operational-error capture. Sits alongside AlertsModule and
 * StagnationModule as a generic infrastructure concern. Modules that want
 * to harden risky paths import this and inject `OperationalErrorService`.
 *
 * No WebSocket dependency — works identically in NORMAL and ACTION modes.
 */
@Module({
  imports: [DiscordHookModule],
  providers: [OperationalErrorService],
  exports: [OperationalErrorService],
})
export class OperationalErrorModule {}

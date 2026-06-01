import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';

/**
 * Severity ordering matches the captured-error spec:
 *   LOW      best-effort side-effect failed (Discord webhook, analytics export)
 *   MEDIUM   business path degraded but recoverable
 *   HIGH     business-critical failure (mutation rolled back, data not persisted)
 *   CRITICAL reserved for cross-cutting outages (DB down, secrets missing)
 */
export type OperationalErrorSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface OperationalErrorInput {
  module: string;
  submodule: string;
  /** Logical method name (e.g. CREATEDI, ADD_BL_PDF). Free-form. */
  method: string;
  severity: OperationalErrorSeverity;
  /** Short human-readable label for what failed ('Failed to create DI'). */
  error: string;
  /** Underlying error.message (or anything string-coercible). */
  message: string;
  /** Free-form payload — ids, args, anything useful for debugging. */
  payload?: Record<string, any>;
}

/**
 * Single public method: capture(...). Persists a structured operational
 * error to a daily log file AND notifies Discord. NEVER throws — callers
 * always `await capture(...)` and then carry on (either rethrowing the
 * original error or returning a safe default).
 *
 * Used by progressively-hardened call sites across modules. Today: DI.
 */
@Injectable()
export class OperationalErrorService {
  private readonly logger = new Logger(OperationalErrorService.name);

  constructor(private readonly discordHookService: DiscordHookService) {}

  async capture(input: OperationalErrorInput): Promise<void> {
    const entry = {
      timestamp: new Date().toISOString(),
      module: input.module,
      submodule: input.submodule,
      method: input.method,
      severity: input.severity,
      error: input.error,
      message: input.message,
      payload: input.payload ?? {},
    };

    // 1. Append to /logs/YYYY-MM/errors-YYYY-MM-DD.log
    //    Both fs.mkdirSync and fs.appendFileSync are wrapped — any IO error
    //    is logged through Nest and never bubbles to the caller.
    try {
      const now = new Date();
      const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const ymd = `${ym}-${String(now.getUTCDate()).padStart(2, '0')}`;
      const dir = join(process.cwd(), 'logs', ym);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        join(dir, `errors-${ymd}.log`),
        JSON.stringify(entry) + '\n',
        { encoding: 'utf8' },
      );
    } catch (fsErr) {
      this.logger.error(
        `Filesystem persistence failed for operational error ${input.module}/${input.method}: ${(fsErr as Error).message ?? fsErr}`,
      );
    }

    // 2. Discord notification — reuse existing webhook. Best-effort.
    try {
      await this.discordHookService.sendOperationalError(entry);
    } catch (discordErr) {
      this.logger.error(
        `Discord operational-error notification failed (${input.module}/${input.method}): ${(discordErr as Error).message ?? discordErr}`,
      );
    }

    // 3. Always emit a Nest log line too — so terminal + log files stay in sync.
    const tag = `${input.module}/${input.submodule}/${input.method}`;
    this.logger.error(`[${input.severity}] ${tag} · ${input.error} · ${input.message}`);
  }
}

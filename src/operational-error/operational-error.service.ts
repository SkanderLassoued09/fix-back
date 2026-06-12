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
  /** Free-form payload — ids, correlation id, anything useful for debugging.
   *  ⚠️ Keep it PII-free: it is previewed in the Discord embed. Pass ids, not
   *  full entities / emails / phones / tokens. */
  payload?: Record<string, any>;
  /**
   * Discord notification gate. `false` for EXPECTED errors (validation / 4xx /
   * NOT_FOUND / user input) — those are logged to file + Nest only, NOT pushed
   * to Discord (avoids alert spam). Defaults to `true` (operational errors).
   */
  notify?: boolean;
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

  /** Discord dedup window — identical (module/method/error) alerts are sent
   *  at most once per window to avoid flooding the channel on a repeating
   *  failure. The full detail is always written to the daily log file. */
  private static readonly DEDUP_WINDOW_MS = 5 * 60 * 1000;
  private readonly lastNotifiedAt = new Map<string, number>();

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

    // 2. Discord notification — reuse existing webhook. Best-effort, and
    //    GUARDED: skipped for expected errors (notify === false) and
    //    rate-limited/deduped per (module/method/error) window.
    if (input.notify !== false && this.shouldNotify(input)) {
      try {
        await this.discordHookService.sendOperationalError(entry);
      } catch (discordErr) {
        this.logger.error(
          `Discord operational-error notification failed (${input.module}/${input.method}): ${(discordErr as Error).message ?? discordErr}`,
        );
      }
    }

    // 3. Always emit a Nest log line too — level by severity so EXPECTED/LOW
    //    errors stay quiet (debug) and operational ones are loud (error).
    const tag = `${input.module}/${input.submodule}/${input.method}`;
    const line = `[${input.severity}] ${tag} · ${input.error} · ${input.message}`;
    if (input.severity === 'LOW') this.logger.debug(line);
    else if (input.severity === 'MEDIUM') this.logger.warn(line);
    else this.logger.error(line);
  }

  // ── Validation channel (separate webhook, dev-only, anti-storm) ──────────
  private readonly validationLastAt = new Map<string, number>();
  private validationWindowStart = 0;
  private validationSentInWindow = 0;
  private validationSuppressed = 0;

  private get validationEnabled(): boolean {
    return (
      process.env.DISCORD_NOTIFY_VALIDATION === 'true' &&
      process.env.NODE_ENV !== 'production'
    );
  }
  private get validationDedupMs(): number {
    return Number(process.env.DISCORD_VALIDATION_DEDUP_MS) || 10 * 60 * 1000;
  }
  private get validationCapPerHour(): number {
    return Number(process.env.DISCORD_VALIDATION_CAP_PER_HOUR) || 20;
  }

  /** A validation message that should NEVER reach the back if the front gates
   *  correctly → front↔back DRIFT (not a user typo). */
  private isDriftSignal(m: string): boolean {
    return /should not be empty|should not exist|must be a (string|number|boolean|array|object)/i.test(
      m,
    );
  }

  /**
   * Surface ValidationPipe (`BAD_REQUEST`) messages on a SEPARATE Discord
   * channel for dev drift-detection. Independent of the critical channel
   * (which stays `notify:false` on 4xx). HEAVILY GATED:
   *   - only when `DISCORD_NOTIFY_VALIDATION=true` AND not production,
   *   - per-key dedup window (operation + sorted messages),
   *   - global hourly cap; excess aggregated into a "+N" counter.
   * Never throws (called fire-and-forget from the filter). Sends NO PII —
   * only the field+rule messages.
   */
  async captureValidation(input: {
    operation: string;
    messages: string[];
    correlationId: string;
    /** false for test traffic (x-test-run) → skip Discord entirely. */
    notify?: boolean;
  }): Promise<void> {
    try {
      if (input.notify === false) return; // test traffic — logged elsewhere, no Discord
      if (!this.validationEnabled) return;
      const messages = (input.messages ?? []).filter(Boolean);
      if (!messages.length) return;

      const now = Date.now();

      // Reset the hourly cap window.
      if (now - this.validationWindowStart >= 60 * 60 * 1000) {
        this.validationWindowStart = now;
        this.validationSentInWindow = 0;
      }

      // Per-key dedup (operation + sorted messages).
      const key = `${input.operation}::${[...messages].sort().join('|')}`;
      if (now - (this.validationLastAt.get(key) ?? 0) < this.validationDedupMs) {
        this.logger.debug(`[validation-notify] deduped · ${input.operation}`);
        return;
      }

      // Hourly cap — beyond it, aggregate into the suppressed counter.
      if (this.validationSentInWindow >= this.validationCapPerHour) {
        this.validationSuppressed++;
        this.logger.debug(
          `[validation-notify] capped (${this.validationCapPerHour}/h) · aggregating`,
        );
        return;
      }

      this.validationLastAt.set(key, now);
      if (this.validationLastAt.size > 500) this.validationLastAt.clear();
      this.validationSentInWindow++;

      const annotated = messages.map((m) => ({
        message: m,
        drift: this.isDriftSignal(m),
      }));
      const suppressed = this.validationSuppressed;
      this.validationSuppressed = 0;

      this.logger.log(
        `[validation-notify] op=${input.operation} msgs=${messages.length} drift=${annotated.some(
          (a) => a.drift,
        )} corr=${input.correlationId}`,
      );

      try {
        await this.discordHookService.sendValidationError({
          operation: input.operation,
          env: process.env.NODE_ENV ?? 'dev',
          correlationId: input.correlationId,
          messages: annotated,
          suppressed,
        });
      } catch (err) {
        this.logger.error(
          `Validation Discord notify failed (${input.operation}): ${
            (err as Error).message ?? err
          }`,
        );
      }
    } catch (outer) {
      // Must never throw into the exception filter.
      this.logger.error(
        `captureValidation failed: ${(outer as Error).message ?? outer}`,
      );
    }
  }

  /** Dedup gate: true at most once per DEDUP_WINDOW_MS per (module/method/error). */
  private shouldNotify(input: OperationalErrorInput): boolean {
    const key = `${input.module}/${input.method}/${input.error}`;
    const now = Date.now();
    const last = this.lastNotifiedAt.get(key) ?? 0;
    if (now - last < OperationalErrorService.DEDUP_WINDOW_MS) {
      this.logger.debug(`Discord notify deduped for ${key}`);
      return false;
    }
    this.lastNotifiedAt.set(key, now);
    // Bound the map so a long-running process can't leak unbounded keys.
    if (this.lastNotifiedAt.size > 500) this.lastNotifiedAt.clear();
    return true;
  }
}

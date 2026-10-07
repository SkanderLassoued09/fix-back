import { HttpException, Logger } from '@nestjs/common';

/**
 * Per-method error context. Every service / resolver / controller method is
 * wrapped in:
 *
 *   try { ... } catch (error) { throw withErrorContext(error, 'DiService.createDi'); }
 *
 * CONTRACT:
 *  - The SAME error is rethrown, unchanged — callers, the global
 *    `AllExceptionsFilter` and the front see exactly what they saw before.
 *  - The error is tagged (non-enumerable) with the INNERMOST method it went
 *    through, and logged ONCE there (with the stack). Outer frames that
 *    rethrow the same error see the tag and stay silent → no log cascade.
 *  - Discord: the innermost frame hands a `CatchReport` to the reporter that
 *    `OperationalErrorService` registers at startup (`setErrorReporter`). The
 *    error is then marked `wasReported` so the global filter doesn't alert twice.
 *    No reporter registered (unit tests, scripts) → no Discord.
 */

/** Codes that are user-facing / expected, not operational — logged at debug. */
export const EXPECTED_ERROR_CODES = new Set([
  'BAD_REQUEST',
  'BAD_USER_INPUT',
  'GRAPHQL_VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'PERSISTED_QUERY_NOT_FOUND',
]);

const ORIGIN = Symbol.for('fixtronix.errorOrigin');
const REPORTED = Symbol.for('fixtronix.errorReported');
const logger = new Logger('ErrorContext');

/** Discord alert shape: `{ title, key, error }` — `key` is unique per method. */
export interface CatchReport {
  title: string;
  key: string;
  error: { name: string; message: string; code: string | null; stack: string | null };
}

let reporter: ((report: CatchReport) => void) | null = null;

export function setErrorReporter(fn: ((report: CatchReport) => void) | null): void {
  reporter = fn;
}

/** True once a catch block already sent this error to Discord. */
export function wasReported(error: unknown): boolean {
  return error !== null && typeof error === 'object' && REPORTED in (error as object);
}

/** `'CompanysService.removeCompany'` → title `removeCompany`, key `removeCompany_CompanysService_error`. */
export function buildCatchReport(error: unknown, origin: string): CatchReport {
  const dot = origin.lastIndexOf('.');
  const method = dot >= 0 ? origin.slice(dot + 1) : origin;
  const klass = dot >= 0 ? origin.slice(0, dot) : '';
  const e: any = error;
  const code =
    e?.extensions?.code ??
    (error instanceof HttpException ? error.getStatus() : undefined);
  return {
    title: method,
    key: [method, klass, 'error'].filter(Boolean).join('_'),
    error: {
      name: error instanceof Error ? error.name : typeof error,
      message:
        error instanceof Error ? error.message : String(error ?? 'Unknown error'),
      code: code == null ? null : String(code),
      stack: error instanceof Error ? error.stack ?? null : null,
    },
  };
}

function report(error: unknown, origin: string): void {
  // One alert per error, whichever catch block (swallowing or rethrowing) saw it first.
  if (!reporter || wasReported(error)) return;
  try {
    if (error !== null && typeof error === 'object') {
      Object.defineProperty(error, REPORTED, { value: true, enumerable: false, configurable: true });
    }
    reporter(buildCatchReport(error, origin));
  } catch {
    // An alert must never change the rethrow.
  }
}

export function isExpectedError(error: unknown): boolean {
  if (error instanceof HttpException) return error.getStatus() < 500;
  const code = (error as any)?.extensions?.code;
  return code != null && EXPECTED_ERROR_CODES.has(String(code));
}

/** Method (`Class.method`) where the error was first caught, if tagged. */
export function errorOrigin(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  return (error as any)[ORIGIN];
}

/**
 * For catch blocks that do NOT rethrow through `withErrorContext` (they swallow
 * the error or throw a different one): sends the same Discord alert, changes
 * nothing else. Skipped when an inner `withErrorContext` already sent it.
 */
export function reportCatchError(error: unknown, origin: string): void {
  report(error, origin);
}

/** Tags + logs `error` once, then returns it for the caller to rethrow. */
export function withErrorContext<E>(error: E, origin: string): E {
  const isObject = error !== null && typeof error === 'object';
  if (isObject && ORIGIN in (error as object)) return error;

  if (isObject) {
    try {
      Object.defineProperty(error, ORIGIN, {
        value: origin,
        enumerable: false,
        configurable: true,
      });
    } catch {
      // Frozen / exotic object — still log below, just untagged.
    }
  }

  const message =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
  if (isExpectedError(error)) {
    logger.debug(`${origin} · ${message}`);
  } else {
    logger.error(
      `${origin} · ${message}`,
      error instanceof Error ? error.stack : undefined,
    );
  }
  report(error, origin);
  return error;
}

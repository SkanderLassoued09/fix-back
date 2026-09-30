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
 *  - Discord / operational-log reporting stays in the global filter (it reads
 *    the tag via `errorOrigin`) — this helper never notifies, so no double alert.
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
const logger = new Logger('ErrorContext');

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
  return error;
}

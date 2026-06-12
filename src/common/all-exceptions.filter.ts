import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { randomUUID } from 'crypto';
import { OperationalErrorService } from '../operational-error/operational-error.service';

/**
 * Global safety net (Phase 3): every unhandled exception — GraphQL or HTTP —
 * is logged + (selectively) notified via `OperationalErrorService`, even when
 * the resolver/service has no explicit try/catch.
 *
 * GUARDRAILS:
 *  - EXPECTED errors (validation / 4xx / NOT_FOUND / user input) → log only,
 *    NO Discord (avoids alert spam). OPERATIONAL errors (5xx / unhandled) →
 *    Discord (deduped by OperationalErrorService).
 *  - Payload is PII-free: only the error code + a correlation id.
 *  - The original error is re-propagated unchanged (Apollo `formatError` still
 *    sanitizes the client-facing response) — the filter NEVER swallows it.
 */
const EXPECTED_CODES = new Set([
  'BAD_REQUEST',
  'BAD_USER_INPUT',
  'GRAPHQL_VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'PERSISTED_QUERY_NOT_FOUND',
]);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly opError: OperationalErrorService) {}

  catch(exception: unknown, host: ArgumentsHost): any {
    const correlationId = randomUUID();
    const expected = this.isExpected(exception);
    const code = this.codeOf(exception);
    const message = this.messageOf(exception);
    const isGraphql = host.getType<GqlContextType>() === 'graphql';
    const operation = this.opName(host, isGraphql);

    // Test-traffic marker: the QA suites send `x-test-run: 1` so their
    // intentional invalid-input bursts are LOGGED but never pushed to Discord.
    const isTest = this.isTestRequest(host, isGraphql);

    // ValidationPipe (BAD_REQUEST) field messages — capture them so the log +
    // alert are ACTIONABLE (which field failed), not a bare "Bad Request".
    const validationMessages = this.validationMessages(exception);

    // Side effect only — capture() never throws. Fire-and-forget so we don't
    // delay the error response.
    void this.opError.capture({
      module: 'global',
      submodule: isGraphql ? 'graphql' : 'http',
      method: operation,
      severity: expected ? 'LOW' : 'HIGH',
      error: expected ? `Handled (${code})` : 'Unhandled exception',
      message,
      notify: !expected, // expected → log only; operational → Discord (deduped)
      payload: {
        code,
        correlationId,
        ...(validationMessages.length ? { validationMessages } : {}),
        ...(isTest ? { test: true } : {}),
      },
    });

    // ValidationPipe (BAD_REQUEST) → SEPARATE, dev-only validation channel for
    // drift visibility. Independent of the critical capture above (notify:false).
    // Test traffic → notify:false (logged above, no Discord). No double-notify:
    // distinct channels + own dedup.
    if (validationMessages.length) {
      void this.opError.captureValidation({
        operation: `${isGraphql ? 'graphql' : 'http'}/${operation}`,
        messages: validationMessages,
        correlationId,
        notify: !isTest,
      });
    }

    if (isGraphql) {
      // Re-propagate so the normal GraphQL error flow + Apollo formatError
      // produce the client response. Returning the error = NestJS gql rethrow.
      return exception instanceof Error
        ? exception
        : new GraphQLError(message, { extensions: { code, correlationId } });
    }

    // HTTP fallback (e.g. static /docs) — respond without leaking internals.
    const res: any = host.switchToHttp().getResponse();
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    if (res?.status) {
      res.status(status).json({
        statusCode: status,
        message: expected ? message : 'Internal server error',
        correlationId,
      });
    }
    return undefined;
  }

  private isExpected(exception: unknown): boolean {
    if (exception instanceof HttpException) return exception.getStatus() < 500;
    return EXPECTED_CODES.has(this.codeOf(exception));
  }

  private codeOf(exception: unknown): string {
    const ext = (exception as any)?.extensions;
    if (ext?.code) return String(ext.code);
    if (exception instanceof HttpException) {
      const s = exception.getStatus();
      if (s === 404) return 'NOT_FOUND';
      if (s === 400) return 'BAD_REQUEST';
      if (s === 401) return 'UNAUTHENTICATED';
      if (s === 403) return 'FORBIDDEN';
      if (s >= 500) return 'INTERNAL_SERVER_ERROR';
      return `HTTP_${s}`;
    }
    return 'INTERNAL_SERVER_ERROR';
  }

  /** True when the request carries the QA test marker header `x-test-run: 1`
   *  → the error is logged but NOT pushed to Discord (avoids test-burst spam). */
  private isTestRequest(host: ArgumentsHost, isGraphql: boolean): boolean {
    try {
      const req: any = isGraphql
        ? GqlArgumentsHost.create(host).getContext()?.req
        : host.switchToHttp().getRequest();
      const h = req?.headers?.['x-test-run'];
      return String(Array.isArray(h) ? h[0] : h ?? '') === '1';
    } catch {
      return false;
    }
  }

  /** Extract class-validator messages from a ValidationPipe BadRequestException
   *  (`getResponse().message` is a string[]). Empty array otherwise. */
  private validationMessages(exception: unknown): string[] {
    if (!(exception instanceof BadRequestException)) return [];
    const res: any = exception.getResponse();
    return Array.isArray(res?.message) ? res.message.filter(Boolean) : [];
  }

  private messageOf(exception: unknown): string {
    if (exception instanceof Error) return exception.message;
    return typeof exception === 'string' ? exception : 'Unknown error';
  }

  private opName(host: ArgumentsHost, isGraphql: boolean): string {
    try {
      if (isGraphql) {
        const info: any = GqlArgumentsHost.create(host).getInfo();
        return info?.fieldName ?? 'graphql';
      }
      const req: any = host.switchToHttp().getRequest();
      return `${req?.method ?? 'HTTP'} ${req?.url ?? ''}`.trim();
    } catch {
      return isGraphql ? 'graphql' : 'http';
    }
  }
}

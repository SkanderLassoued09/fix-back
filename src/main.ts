// Load .env BEFORE anything else imports a service that reads process.env
// (Google Sheets client checks GOOGLE_SHEETS_ID; same bootstrap covers
// both NORMAL and ACTION modes so one line keeps env-var setup uniform).
import 'dotenv/config';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { AppCronService } from './cron/cron.service';

/**
 * Single bootstrap entrypoint, two modes:
 *
 *   NORMAL (default)        — HTTP + GraphQL + WebSocket runtime
 *   ACTION (env ACTION=…)   — standalone DI container, dispatches to
 *                              AppCronService.runAction(...)
 *
 * Usage:
 *   npm run start:dev                                    → NORMAL
 *   ACTION=DETECT_STAGNANT_DI npm run start:dev          → ACTION
 *   npm run action:detect-stagnant-di                    → ACTION (alias)
 *
 * No business logic in this file. Adding a new action = one more case in
 * AppCronService.runAction().
 */
async function bootstrap() {
  const action = process.env.ACTION;

  if (action) {
    const logger = new Logger('Action');
    logger.log(`ACTION started: ${action}`);
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['log', 'warn', 'error'],
    });
    try {
      await app.get(AppCronService).runAction(action);
      logger.log(`ACTION completed: ${action}`);
    } catch (err) {
      logger.error(`ACTION failed: ${action} — ${(err as Error).stack ?? err}`);
      process.exitCode = 1;
    } finally {
      await app.close();
    }
    return;
  }

  const app = await NestFactory.create(AppModule);
  // Activate class-validator on all GraphQL/REST inputs. `transform: true`
  // runs the validators (and class-transformer decorators like @Trim/@Type).
  // We deliberately DO NOT set `forbidNonWhitelisted`: the GraphQL schema is
  // already the whitelist, and forbidding would risk breaking unrelated
  // mutations that were never validated before.
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // CORS: an explicit allow-list from CORS_ORIGIN (comma-separated), or — when
  // unset (dev) — reflect the caller's Origin. `origin: true` echoes the
  // request Origin back, which (unlike '*') is compatible with credentialed
  // requests; `methods`/`allowedHeaders` cover the preflight for the Apollo
  // client (Content-Type + Authorization) and the QA `x-test-run` marker.
  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
    : true;
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-test-run'],
  });

  const bodyLimit = process.env.BODY_LIMIT || '5gb';
  app.use(bodyParser.json({ limit: bodyLimit }));
  app.use(bodyParser.urlencoded({ limit: bodyLimit, extended: true }));

  const port = process.env.PORT ?? 3000;
  await app.listen(port, '192.168.1.30');
  new Logger('Bootstrap').log(`Fixtronix API listening on port ${port}`);
}

bootstrap();

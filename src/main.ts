// Load the SINGLE targeted env file `.env.${NODE_ENV}` BEFORE anything else
// imports a service that reads process.env. This side-effect import REPLACES the
// old `import 'dotenv/config'` (which loaded a plain `.env`) and must stay FIRST.
// The environment is selected by the CLI (`bin/fixtronix.js`); default = development.
import './config/load-env';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { AppCronService } from './cron/cron.service';
import { buildActionBanner, buildStartupBanner } from './config/env-banner';

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
  // Trim so a stray trailing space/CR (e.g. Windows CMD `set ACTION=NAME `,
  // or a CRLF-terminated value) can't turn a valid action into "Unknown ACTION"
  // — and a whitespace-only value falls back to the HTTP server, not ACTION mode.
  const action = process.env.ACTION?.trim() || undefined;

  if (action) {
    const logger = new Logger('Action');
    // Short one-line banner so a standalone cron logs its environment too.
    console.log(buildActionBanner(process.env.NODE_ENV || 'development', action));
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
  await app.listen(port);
  // Loud, colored environment banner (green dev / amber preprod / red prod).
  // Shows env, loaded file, DB name + port — NEVER any secret.
  console.log(
    '\n' +
      buildStartupBanner({
        nodeEnv: process.env.NODE_ENV || 'development',
        port,
        mongoUri: process.env.MONGODB_URI,
      }),
  );
  new Logger('Bootstrap').log(
    `Fixtronix API listening on port ${port} — env: ${process.env.NODE_ENV}`,
  );
}

bootstrap();

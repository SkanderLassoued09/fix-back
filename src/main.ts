import { Logger } from '@nestjs/common';
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
  app.enableCors();
  app.use(bodyParser.json({ limit: '5gb' }));
  app.use(bodyParser.urlencoded({ limit: '5gb', extended: true }));

  await app.listen(3000);
}

bootstrap();

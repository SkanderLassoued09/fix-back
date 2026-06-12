import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
// import { ApolloDriverConfig, ApolloDriver } from '@nestjs/apollo';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { MongooseModule } from '@nestjs/mongoose';
import { LocationModule } from './location/location.module';
import { CompanysModule } from './company/company.module';
import { ClientsModule } from './clients/clients.module';
import { ComposantModule } from './composant/composant.module';
import { ComposantCategoryModule } from './composant_category/composant_category.module';
import { DiCategoryModule } from './di_category/di_category.module';
import { DiModule } from './di/di.module';
import { TarifModule } from './tarif/tarif.module';
import { RemarqueModule } from './remarque/remarque.module';
import { ProfileModule } from './profile/profile.module';
import { AuthModule } from './auth/auth.module';
import { StatModule } from './stat/stat.module';
import { CronModule } from './cron/cron.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AuditModule } from './audit/audit.module';
import { LogsDiModule } from './logs-di/logs-di.module';
import { DashboardKpiModule } from './dashboard-kpi/dashboard-kpi.module';
import { DiscordHookModule } from './discord-hook/discord-hook.module';
import { AlertsModule } from './alerts/alerts.module';
import { StagnationModule } from './stagnation/stagnation.module';
import { OperationalErrorModule } from './operational-error/operational-error.module';
import { GoogleSheetsModule } from './google-sheets/google-sheets.module';

@Module({
  imports: [
    LocationModule,
    CompanysModule,
    MongooseModule.forRoot(
      process.env.MONGODB_URI || 'mongodb://localhost:27017/fixtronix',
    ),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      // Disable in production by setting GRAPHQL_PLAYGROUND=false.
      playground: process.env.GRAPHQL_PLAYGROUND !== 'false',
      autoSchemaFile: true,
      installSubscriptionHandlers: true,
      // Never leak stack traces / internal details to clients (Apollo was
      // including `extensions.stacktrace` on every error). Keep a readable
      // message + code, and surface class-validator field messages (from the
      // ValidationPipe's BadRequestException) so the client gets actionable
      // per-field detail — without exposing internals.
      formatError: (error) => {
        const orig: any = (error.extensions as any)?.originalError;
        const code = (error.extensions as any)?.code ?? 'BAD_REQUEST';
        // Business-conflict errors name the offending DTO field so the front
        // can surface them inline (CONFLICT → e.g. field: 'raisonSociale').
        const field = (error.extensions as any)?.field;
        let message = error.message;
        let validation: string[] | undefined;
        if (orig?.message) {
          if (Array.isArray(orig.message)) {
            validation = orig.message;
            message = orig.message.join('; ');
          } else if (typeof orig.message === 'string') {
            message = orig.message;
          }
        }
        return {
          message,
          extensions: {
            code,
            ...(validation ? { validation } : {}),
            ...(field ? { field } : {}),
          },
          path: error.path,
        };
      },
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'docs'),
    }),

    ProfileModule,
    AuthModule,
    ClientsModule,
    ComposantModule,
    ComposantCategoryModule,
    DiCategoryModule,
    DiModule,
    TarifModule,
    RemarqueModule,
    StatModule,
    CronModule,
    AuditModule,
    LogsDiModule,
    DashboardKpiModule,
    DiscordHookModule,
    AlertsModule,
    StagnationModule,
    OperationalErrorModule,
    GoogleSheetsModule,
  ],
  controllers: [],
  providers: [
    // Global safety net: log + (operational-only) notify every unhandled
    // exception. OperationalErrorModule is imported above, so the filter can
    // inject OperationalErrorService.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
// import { ApolloDriverConfig, ApolloDriver } from '@nestjs/apollo';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
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

@Module({
  imports: [
    LocationModule,
    CompanysModule,
    MongooseModule.forRoot(
      'mongodb+srv://benjemianezih:fixtronix@fixtronixdatabase.1xkjlbq.mongodb.net/',
    ),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      playground: true,
      autoSchemaFile: true,
      installSubscriptionHandlers: true,
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
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ApolloDriverConfig, ApolloDriver } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { MongooseModule } from '@nestjs/mongoose';
import { LocationModule } from './location/location.module';
import { CompaniesModule } from './companies/companies.module';
import { ClientsModule } from './clients/clients.module';
import { ComposantModule } from './composant/composant.module';
import { ComposantCategorieModule } from './composant_categorie/composant_categorie.module';
import { DiCategorieModule } from './di_categorie/di_categorie.module';
import { DiModule } from './di/di.module';

@Module({
  imports: [
    LocationModule,
    CompaniesModule,
    MongooseModule.forRoot(
      'mongodb+srv://benjemianezih:fixtronix@fixtronixdatabase.1xkjlbq.mongodb.net/',
    ),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      playground: true,
      autoSchemaFile: true,
    }),
    ClientsModule,
    ComposantModule,
    ComposantCategorieModule,
    DiCategorieModule,
    DiModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}

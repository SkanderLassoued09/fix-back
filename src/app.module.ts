import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EmplacementModule } from './emplacement/emplacement.module';
import { MongooseModule } from '@nestjs/mongoose';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';

@Module({
  imports: [
    EmplacementModule,
    MongooseModule.forRoot(
      'mongodb+srv://skander009:pAkAJsxUvBbzsIv8@tpedb.yy1h9.mongodb.net/ERP?retryWrites=true&w=majority',

      //mongodb+srv://benjemianezih:DpAqvjM2vP4v7._@fixtronixdatabase.1xkjlbq.mongodb.net/
    ),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: 'schema.gql',
      playground: true,
      introspection: true,
      context: ({ req }) => ({ req }),
      installSubscriptionHandlers: true,
      subscriptions: {
        'subscriptions-transport-ws': {
          keepAlive: 5000,
          onConnect: () => {
            console.log('🍡 connected');
          },
          onDisconnect: () => {
            console.log('🍖 Disconnect');
          },
        },
      },
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

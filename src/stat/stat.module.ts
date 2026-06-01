import { MongooseModule } from '@nestjs/mongoose';
import { Stat, StatSchema } from './entities/stat.entity';
import { Module } from '@nestjs/common';
import { StatResolver } from './stat.resolver';
import { StatService } from './stat.service';
import { PubSubModule } from 'src/pubsub/pubsub.module';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
import { Profile, ProfileSchema } from 'src/profile/entities/profile.entity';
import { Di } from 'src/di/entities/di.entity';
import { LogsDiModule } from 'src/logs-di/logs-di.module';
import {
  Location,
  LocationSchema,
} from 'src/location/entities/location.entity';
import { Company, CompanySchema } from 'src/company/entities/company.entity';
import { Client, ClientSchema } from 'src/clients/entities/client.entity';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import { OperationalErrorModule } from 'src/operational-error/operational-error.module';

@Module({
  providers: [
    StatResolver,
    StatService,
    NotificationsGateway,
    ProfileService,
  ],
  imports: [
    DiscordHookModule,
    OperationalErrorModule,
    LogsDiModule,
    PubSubModule,
    MongooseModule.forFeature([
      {
        name: Stat.name,
        schema: StatSchema,
      },
      {
        name: Profile.name,
        schema: ProfileSchema,
      },
      {
        name: Location.name,
        schema: LocationSchema,
      },
      {
        name: Company.name,
        schema: CompanySchema,
      },
      {
        name: Client.name,
        schema: ClientSchema,
      },
      {
        name: Di.name,
        schema: ProfileSchema,
      },
    ]),
  ],
  exports: [StatService],
})
export class StatModule {}

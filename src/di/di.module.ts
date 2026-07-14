import { Module } from '@nestjs/common';
import { DiService } from './di.service';
import { DiResolver } from './di.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { Di, DiSchema } from './entities/di.entity';
import {
  Composant,
  ComposantSchema,
} from 'src/composant/entities/composant.entity';
import {
  Remarque,
  RemarqueSchema,
} from 'src/remarque/entities/remarque.entity';
import { StatService } from 'src/stat/stat.service';

import { Stat, StatSchema } from 'src/stat/entities/stat.entity';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';

import { Profile, ProfileSchema } from 'src/profile/entities/profile.entity';
import { PubSubModule } from 'src/pubsub/pubsub.module';
import { AuditModule } from 'src/audit/audit.module';
import { LogsDiModule } from 'src/logs-di/logs-di.module';
import { Client, ClientSchema } from 'src/clients/entities/client.entity';
import { Company, CompanySchema } from 'src/company/entities/company.entity';
import {
  Location,
  LocationSchema,
} from 'src/location/entities/location.entity';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import { DiWorkflowService } from './workflow/di-workflow.service';
import { OperationalErrorModule } from 'src/operational-error/operational-error.module';
import { GoogleDriveModule } from 'src/google-drive/google-drive.module';
import { ClientsModule } from 'src/clients/clients.module';
import { LocationModule } from 'src/location/location.module';
import { DiImportController } from './import/di-import.controller';
import { DiImportService } from './import/di-import.service';
import { DiImageController } from './di-image.controller';

@Module({
  controllers: [DiImportController, DiImageController],
  providers: [
    DiResolver,
    DiService,
    StatService,
    NotificationsGateway,
    ProfileService,
    DiWorkflowService,
    DiImportService,
  ],
  imports: [
    DiscordHookModule,
    PubSubModule,
    AuditModule,
    LogsDiModule,
    OperationalErrorModule,
    GoogleDriveModule,
    ClientsModule,
    LocationModule,
    MongooseModule.forFeature([
      {
        name: Di.name,
        schema: DiSchema,
      },
      {
        name: Composant.name,
        schema: ComposantSchema,
      },
      {
        name: Remarque.name,
        schema: RemarqueSchema,
      },
      {
        name: Stat.name,
        schema: StatSchema,
      },
      {
        name: Profile.name,
        schema: ProfileSchema,
      },
      {
        name: Client.name,
        schema: ClientSchema,
      },
      {
        name: Company.name,
        schema: CompanySchema,
      },
      {
        name: Location.name,
        schema: LocationSchema,
      },
    ]),
  ],
  exports: [DiService],
})
export class DiModule {}

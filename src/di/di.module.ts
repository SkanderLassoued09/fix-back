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

@Module({
  providers: [
    DiResolver,
    DiService,
    StatService,
    NotificationsGateway,
    ProfileService,
  ],
  imports: [
    PubSubModule,
    AuditModule,
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
    ]),
  ],
  exports: [DiService],
})
export class DiModule {}

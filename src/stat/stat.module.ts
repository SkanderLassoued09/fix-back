import { MongooseModule } from '@nestjs/mongoose';
import { Stat, StatSchema } from './entities/stat.entity';
import { Module } from '@nestjs/common';
import { StatResolver } from './stat.resolver';
import { StatService } from './stat.service';
import { PubSubModule } from 'src/pubsub/pubsub.module';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
import { Profile, ProfileSchema } from 'src/profile/entities/profile.entity';

@Module({
  providers: [StatResolver, StatService, NotificationsGateway, ProfileService],
  imports: [
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
    ]),
  ],
  exports: [StatService],
})
export class StatModule {}

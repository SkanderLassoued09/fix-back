import { MongooseModule } from '@nestjs/mongoose';
import { StatSchema } from './entities/stat.entity';
import { Module } from '@nestjs/common';
import { StatResolver } from './stat.resolver';
import { StatService } from './stat.service';
import { PubSubModule } from 'src/pubsub/pubsub.module';

@Module({
  providers: [StatResolver, StatService],
  imports: [
    PubSubModule,
    MongooseModule.forFeature([
      {
        name: 'Stat',
        schema: StatSchema,
      },
    ]),
  ],
  exports: [StatService],
})
export class StatModule {}

import { Module } from '@nestjs/common';
import { StatsService } from './stats.service';
import { StatsResolver } from './stats.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { StatSchema } from './entities/stat.entity';

@Module({
  providers: [StatsResolver, StatsService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Stat',
        schema: StatSchema,
      },
    ]),
  ],
  exports: [StatsService],
})
export class StatsModule {}

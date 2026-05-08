import { Module } from '@nestjs/common';
import { LocationService } from './location.service';
import { LocationResolver } from './location.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { LocationSchema } from './entities/location.entity';
import { Di, DiSchema } from 'src/di/entities/di.entity';

@Module({
  providers: [LocationResolver, LocationService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Location',
        schema: LocationSchema,
      },
      {
        name: Di.name,
        schema: DiSchema,
      },
    ]),
  ],
  exports: [LocationService],
})
export class LocationModule {}

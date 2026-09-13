import { Module } from '@nestjs/common';
import { DiCategoryService } from './di_category.service';
import { DiCategoryResolver } from './di_category.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { DiCategorySchema } from './entities/di_category.entity';
import { NotificationModule } from '../notifications/notification.module';

@Module({
  providers: [DiCategoryResolver, DiCategoryService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'DiCategory',
        schema: DiCategorySchema,
      },
    ]),
    // Exporte `NotificationService` : le resolver s'en sert pour prévenir
    // l'encadrement d'une nouvelle catégorie du référentiel partagé.
    NotificationModule,
  ],
  exports: [DiCategoryService],
})
export class DiCategoryModule {}
/**


@Module({
  providers: [LocationResolver, LocationService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Location',
        schema: LocationSchema,
      },
    ]),
  ],
  exports: [LocationService],
})
export class LocationModule {}

 */

import { Module } from '@nestjs/common';
import { ComposantService } from './composant.service';
import { ComposantResolver } from './composant.resolver';
import { ComposantSchema } from './entities/composant.entity';
import { MongooseModule } from '@nestjs/mongoose';

@Module({
  providers: [ComposantResolver, ComposantService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Composant',
        schema: ComposantSchema,
      },
    ]),
  ],
  exports: [ComposantService],
})
export class ComposantModule {}

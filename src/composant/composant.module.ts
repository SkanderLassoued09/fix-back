import { Module } from '@nestjs/common';
import { ComposantService } from './composant.service';
import { ComposantResolver } from './composant.resolver';
import { ComposantSchema } from './entities/composant.entity';
import { MongooseModule } from '@nestjs/mongoose';
import { OperationalErrorModule } from 'src/operational-error/operational-error.module';

@Module({
  providers: [ComposantResolver, ComposantService],
  imports: [
    OperationalErrorModule,
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

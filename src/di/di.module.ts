import { Module } from '@nestjs/common';
import { DiService } from './di.service';
import { DiResolver } from './di.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { DiSchema } from './entities/di.entity';
import { ComposantSchema } from 'src/composant/entities/composant.entity';

@Module({
  providers: [DiResolver, DiService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Di',
        schema: DiSchema,
      },
      {
        name: 'Composant',
        schema: ComposantSchema,
      },
    ]),
  ],
  exports: [DiService],
})
export class DiModule {}

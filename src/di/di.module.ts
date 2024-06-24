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
import { StatModule } from 'src/stat/stat.module';
import { StatSchema } from 'src/stat/entities/stat.entity';

@Module({
  providers: [DiResolver, DiService, StatService],
  imports: [
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
        name: 'Stat',
        schema: StatSchema,
      },
    ]),
  ],
  exports: [DiService],
})
export class DiModule {}

import { Module } from '@nestjs/common';
import { RemarqueService } from './remarque.service';
import { RemarqueResolver } from './remarque.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { RemarqueSchema } from './entities/remarque.entity';

@Module({
  providers: [RemarqueResolver, RemarqueService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Remarque',
        schema: RemarqueSchema,
      },
    ]),
  ],
  exports: [RemarqueService],
})
export class RemarqueModule {}

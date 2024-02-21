import { Module } from '@nestjs/common';
import { EmplacementService } from './emplacement.service';
import { EmplacementResolver } from './emplacement.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { EmplacementSchema } from './entities/emplacement.entity';
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Emplacement',
        schema: EmplacementSchema,
      },
    ]),
  ],
  providers: [EmplacementResolver, EmplacementService],
  exports: [EmplacementService],
})
export class EmplacementModule {}

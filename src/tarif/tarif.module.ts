import { Module } from '@nestjs/common';
import { TarifService } from './tarif.service';
import { TarifResolver } from './tarif.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { TarifDocument, TarifSchema } from './entities/tarif.entity';

@Module({
  providers: [TarifResolver, TarifService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Tarif',
        schema: TarifSchema,
      },
    ]),
  ],
  exports: [TarifService],
})
export class TarifModule {}

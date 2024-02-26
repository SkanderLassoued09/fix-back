import { Module } from '@nestjs/common';
import { DiCategorieService } from './di_categorie.service';
import { DiCategorieResolver } from './di_categorie.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { DiCategorieSchema } from './entities/di_categorie.entity';

@Module({
  providers: [DiCategorieResolver, DiCategorieService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'DiCategorie',
        schema: DiCategorieSchema,
      },
    ]),
  ],
  exports: [DiCategorieService],
})
export class DiCategorieModule {}

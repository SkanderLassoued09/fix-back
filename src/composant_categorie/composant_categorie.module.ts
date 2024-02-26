import { Module } from '@nestjs/common';
import { Composant_CategorieResolver } from './composant_categorie.resolver';
import { Composant_CategorieService } from './composant_categorie.service';
import { MongooseModule } from '@nestjs/mongoose';
import { Composant_CategorieSchema } from './entities/composant_categorie.entity';

@Module({
  providers: [Composant_CategorieResolver, Composant_CategorieService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Composant_Categorie',
        schema: Composant_CategorieSchema,
      },
    ]),
  ],
  exports: [Composant_CategorieService],
})
export class ComposantCategorieModule {}

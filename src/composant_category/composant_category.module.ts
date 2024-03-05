import { Module } from '@nestjs/common';
import { Composant_CategoryResolver } from './composant_category.resolver';
import { Composant_CategoryService } from './composant_category.service';
import { MongooseModule } from '@nestjs/mongoose';
import { Composant_CategorySchema } from './entities/composant_category.entity';

@Module({
  providers: [Composant_CategoryResolver, Composant_CategoryService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Composant_Category',
        schema: Composant_CategorySchema,
      },
    ]),
  ],
  exports: [Composant_CategoryService],
})
export class ComposantCategoryModule {}

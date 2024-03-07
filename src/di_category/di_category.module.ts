import { Module } from '@nestjs/common';
import { DiCategoryService } from './di_category.service';
import { DiCategoryResolver } from './di_category.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { DiCategorySchema } from './entities/di_category.entity';

@Module({
  providers: [DiCategoryResolver, DiCategoryService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'DiCategory',
        schema: DiCategorySchema,
      },
    ]),
  ],
  exports: [DiCategoryService],
})
export class DiCategoryModule {}

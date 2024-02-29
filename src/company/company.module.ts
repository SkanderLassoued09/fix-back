import { Module } from '@nestjs/common';
import { CompanysService } from './company.service';
import { CompanysResolver } from './company.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { CompanySchema } from './entities/company.entity';

@Module({
  providers: [CompanysResolver, CompanysService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Company',
        schema: CompanySchema,
      },
    ]),
  ],
  exports: [CompanysService],
})
export class CompanysModule {}

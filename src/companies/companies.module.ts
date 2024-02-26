import { Module } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { CompaniesResolver } from './companies.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { LocationSchema } from 'src/location/entities/location.entity';
import { CompanieSchema } from './entities/company.entity';

@Module({
  providers: [CompaniesResolver, CompaniesService],
  imports: [
    MongooseModule.forFeature([
      {
        name: 'Companie',
        schema: CompanieSchema,
      },
    ]),
  ],
  exports: [CompaniesService],
})
export class CompaniesModule {}

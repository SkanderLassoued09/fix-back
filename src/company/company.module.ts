import { Module } from '@nestjs/common';
import { CompanysService } from './company.service';
import { CompanysResolver } from './company.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { CompanySchema } from './entities/company.entity';
import { GoogleDriveModule } from '../google-drive/google-drive.module';
import { OperationalErrorModule } from '../operational-error/operational-error.module';
import { CompanyImportController } from './import/company-import.controller';
import { CompanyImportService } from './import/company-import.service';

@Module({
  controllers: [CompanyImportController],
  providers: [CompanysResolver, CompanysService, CompanyImportService],
  imports: [
    GoogleDriveModule,
    OperationalErrorModule,
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

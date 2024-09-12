import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditResolver } from './audit.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { Audit, AuditSchema } from './entities/audit.entity';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Audit.name, schema: AuditSchema }]),
  ],
  providers: [AuditResolver, AuditService],
  exports: [AuditService],
})
export class AuditModule {}

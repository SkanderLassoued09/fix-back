import { Module } from '@nestjs/common';
import { DiService } from './di.service';
import { DiResolver } from './di.resolver';

@Module({
  providers: [DiResolver, DiService]
})
export class DiModule {}

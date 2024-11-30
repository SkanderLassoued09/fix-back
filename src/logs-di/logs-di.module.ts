import { Module } from '@nestjs/common';
import { LogsDiService } from './logs-di.service';
import { LogsDiResolver } from './logs-di.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { DiLogsSchema, LogsDi } from './entities/logs-di.entity';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: LogsDi.name, schema: DiLogsSchema }]),
  ],
  providers: [LogsDiResolver, LogsDiService],
  exports: [LogsDiService],
})
export class LogsDiModule {}

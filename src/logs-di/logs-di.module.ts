import { Module } from '@nestjs/common';
import { LogsDiService } from './logs-di.service';
import { LogsDiResolver } from './logs-di.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { DiLogsSchema, LogsDi } from './entities/logs-di.entity';
import {
  Composant,
  ComposantSchema,
} from 'src/composant/entities/composant.entity';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LogsDi.name, schema: DiLogsSchema },
      {
        name: Composant.name,
        schema: ComposantSchema,
      },
    ]),
  ],
  providers: [LogsDiResolver, LogsDiService],
  exports: [LogsDiService],
})
export class LogsDiModule {}

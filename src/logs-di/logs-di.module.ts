import { Module } from '@nestjs/common';
import { LogsDiService } from './logs-di.service';
import { LogsDiResolver } from './logs-di.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { DiLogsSchema, LogsDi } from './entities/logs-di.entity';
import {
  Composant,
  ComposantSchema,
} from 'src/composant/entities/composant.entity';
import { OperationalErrorModule } from 'src/operational-error/operational-error.module';

@Module({
  imports: [
    OperationalErrorModule,
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

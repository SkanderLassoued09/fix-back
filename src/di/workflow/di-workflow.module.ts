import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StatModule } from 'src/stat/stat.module';
import { Di, DiSchema } from '../entities/di.entity';
import { DiWorkflowService } from './di-workflow.service';

/**
 * Minimal shell for the workflow layer.
 *
 * The first safe migration registers DiWorkflowService directly in DiModule so
 * it reuses the existing DI/Stat providers and avoids module-graph changes.
 * TODO: move provider wiring here once Stat/DI module boundaries are cleaned up.
 */
@Module({
  imports: [
    StatModule,
    MongooseModule.forFeature([
      {
        name: Di.name,
        schema: DiSchema,
      },
    ]),
  ],
  providers: [DiWorkflowService],
  exports: [DiWorkflowService],
})
export class DiWorkflowModule {}

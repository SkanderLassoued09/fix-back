import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AlertsModule } from 'src/alerts/alerts.module';
import { Di, DiSchema } from 'src/di/entities/di.entity';
import { StagnationService } from './stagnation.service';

/**
 * Stagnation detection is its own module so:
 *   - The cron module can import it without pulling in the whole DI module
 *     (avoids cycles between DI ↔ Alerts ↔ Cron).
 *   - The ACTION runtime can boot just this module via NestFactory's
 *     standalone application context.
 *
 * Schema is registered locally rather than re-using DiModule so the boot
 * surface stays minimal in ACTION mode.
 */
@Module({
  imports: [
    AlertsModule,
    MongooseModule.forFeature([{ name: Di.name, schema: DiSchema }]),
  ],
  providers: [StagnationService],
  exports: [StagnationService],
})
export class StagnationModule {}

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Profile, ProfileSchema } from 'src/profile/entities/profile.entity';
import { SessionCleanupService } from './session-cleanup.service';

/**
 * Libération nocturne des sessions bloquées (minuit Africa/Tunis) : remet
 * `isConnected` à `false`. Module SÉPARÉ et minimal — il enregistre lui-même le
 * modèle `Profile` plutôt que d'importer `AuthModule`/`ProfileModule`, ce qui
 * évite toute dépendance circulaire avec le CronModule. Importé UNIQUEMENT par
 * le CronModule.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Profile.name, schema: ProfileSchema }]),
  ],
  providers: [SessionCleanupService],
  exports: [SessionCleanupService],
})
export class SessionCleanupModule {}

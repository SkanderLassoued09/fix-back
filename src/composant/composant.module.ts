import { Module } from '@nestjs/common';
import { ComposantService } from './composant.service';
import { ComposantResolver } from './composant.resolver';
import { ComposantSchema } from './entities/composant.entity';
import { MongooseModule } from '@nestjs/mongoose';
import { OperationalErrorModule } from 'src/operational-error/operational-error.module';
import { DiSchema } from 'src/di/entities/di.entity';
import { GoogleDriveModule } from 'src/google-drive/google-drive.module';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';

@Module({
  providers: [ComposantResolver, ComposantService],
  imports: [
    OperationalErrorModule,
    GoogleDriveModule,
    DiscordHookModule,
    MongooseModule.forFeature([
      {
        name: 'Composant',
        schema: ComposantSchema,
      },
      // Registered here too so the service can cascade a rename onto DI
      // `array_composants[].nameComposant` (parts are linked by name).
      {
        name: 'Di',
        schema: DiSchema,
      },
    ]),
  ],
  exports: [ComposantService],
})
export class ComposantModule {}

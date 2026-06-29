import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReunionPVService } from './reunion-pv.service';
import { ReunionPVResolver } from './reunion-pv.resolver';
import { ReunionPVSchema } from './entities/reunion-pv.entity';
import { ProfileSchema } from 'src/profile/entities/profile.entity';
import { DiSchema } from 'src/di/entities/di.entity';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import { JiraModule } from 'src/jira/jira.module';

@Module({
  imports: [
    DiscordHookModule,
    // Each "Action à mener" is mirrored into a Jira issue on PV create
    // (best-effort, inert until JIRA_* env is set).
    JiraModule,
    MongooseModule.forFeature([
      { name: 'ReunionPV', schema: ReunionPVSchema },
      // Profile + Di are registered here so the service can validate refs
      // (DI exists, profile exists for createdBy / participants /
      // responsables) and push the new PV id onto Di.pvReunions.
      { name: 'Profile', schema: ProfileSchema },
      { name: 'Di', schema: DiSchema },
    ]),
  ],
  providers: [ReunionPVResolver, ReunionPVService],
  exports: [ReunionPVService],
})
export class ReunionPVModule {}

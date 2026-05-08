import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DiscordHookService } from './discord-hook.service';
import { DiscordHookController } from './discord-hook.controller';
import { Client, ClientSchema } from 'src/clients/entities/client.entity';
import { Company, CompanySchema } from 'src/company/entities/company.entity';
import {
  Profile,
  ProfileSchema,
} from 'src/profile/entities/profile.entity';

@Module({
  controllers: [DiscordHookController],
  providers: [DiscordHookService],
  imports: [
    MongooseModule.forFeature([
      { name: Client.name, schema: ClientSchema },
      { name: Company.name, schema: CompanySchema },
      { name: Profile.name, schema: ProfileSchema },
    ]),
  ],
  exports: [DiscordHookService],
})
export class DiscordHookModule {}

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JiraModule } from 'src/jira/jira.module';
import { DiscordHookModule } from 'src/discord-hook/discord-hook.module';
import { JiraCronNotificationService } from './jira-cron-notification.service';
import { JiraCronNotificationSchema } from './entities/jira-cron-notification.entity';

/**
 * Jira notification pipeline. Imports the Jira REST client (Cron 1 ingestion)
 * and the Discord webhook service (Cron 2 delivery), and registers the
 * `jira_cron_notifications` collection. Exposed to the cron runner
 * (AppCronService) by exporting the service.
 */
@Module({
  imports: [
    JiraModule,
    DiscordHookModule,
    MongooseModule.forFeature([
      { name: 'JiraCronNotification', schema: JiraCronNotificationSchema },
    ]),
  ],
  providers: [JiraCronNotificationService],
  exports: [JiraCronNotificationService],
})
export class JiraCronNotificationModule {}

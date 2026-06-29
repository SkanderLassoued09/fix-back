import { Module } from '@nestjs/common';
import { OperationalErrorModule } from 'src/operational-error/operational-error.module';
import { JiraService } from './jira.service';

/**
 * Jira Cloud integration. Stateless (HTTP-only, no Mongo). Imports
 * OperationalErrorModule so the service can log best-effort failures the same
 * way every other integration does. Feature modules that need to push issues
 * (today: reunion-pv) import this and inject `JiraService`.
 */
@Module({
  imports: [OperationalErrorModule],
  providers: [JiraService],
  exports: [JiraService],
})
export class JiraModule {}

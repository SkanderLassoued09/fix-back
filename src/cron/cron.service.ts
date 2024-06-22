import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PubSub } from 'graphql-subscriptions';
import { DiService } from 'src/di/di.service';
import { Di } from 'src/di/entities/di.entity';
import { NotificationsGateway } from 'src/notification.gateway';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);
  pubSub = new PubSub();
  constructor(
    private readonly diService: DiService,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleNotOpenedDi() {
    const result = await this.diService.getAllNotOpeneddi();
    if (result.length === 0) {
      this.logger.debug('All DI are opned');
    }
    this.logger.debug('cron start');
    this.sendReminder(result);
  }

  sendReminder(di: any) {
    di.forEach((di) => {
      this.logger.debug(`Sending reminder for DI: ${di.title}`);
      this.notificationsGateway.sendReminder(
        `Sending reminder for DI: ${di.title}`,
      );
    });
    // this.notificationsGateway.sendReminder('Hello from the other side');
  }
}

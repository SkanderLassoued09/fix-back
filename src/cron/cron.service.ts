import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PubSub } from 'graphql-subscriptions';
import { AuditService } from 'src/audit/audit.service';
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
    private readonly auditService: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_10_HOURS)
  async emptyAudit() {
    this.auditService.emptyAudit();
  }

  @Cron(CronExpression.EVERY_10_HOURS)
  async handleNotOpenedDi() {
    const result = await this.diService.getAllNotOpeneddi();
    if (result.length === 0) {
      this.logger.debug('All DI are opned');
    }
    this.logger.debug('cron start');
    // this.sendReminder(result); REMINDER
  }

  // dont create audit for ticket al ready exists
  async sendReminder(di: any) {
    // await this.auditService.deleteDocumentsWithReminderField();
    // Map the input data to match the ReminderDataInput type
    const dataToSend = di.map((el) => {
      return {
        _id: el._id, // Assuming 'title' should map to 'name'
        title: el.title, // Assuming '_id' should be converted to 'value'
      };
    });

    // Log the transformed data
    // Prepare the input data for the service call
    const createAuditInput = {
      reminder: {
        data: dataToSend,
        flag: false, // Set flag as needed, for example, false
      },
    };

    const ids = dataToSend.flatMap((el) => {
      return [el._id];
    });

    const isExist = await this.auditService.findExistingReminders(ids);
    // if (isExist.length === 0) {
    //   // Call the create method in the audit service
    //   // const reminder = await this.auditService.create(createAuditInput);

    //   if (reminder) {
    //     this.notificationsGateway.sendReminder({
    //       message: 'You got reminder',
    //       payload: reminder,
    //     });
    //   }
    // }
  }
}

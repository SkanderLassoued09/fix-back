import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { AuditService } from './audit.service';
import { Audit } from './entities/audit.entity';
import { AuditInput } from './dto/create-audit.input';
import { UpdateAuditInput } from './dto/update-audit.input';

@Resolver(() => Audit)
export class AuditResolver {
  constructor(private readonly auditService: AuditService) {}

  @Mutation(() => Audit)
  createAudit(@Args('createAuditInput') auditInput: AuditInput) {
    return this.auditService.create(auditInput);
  }

  @Query(() => [Audit])
  remindersNotification() {
    return this.auditService.getRemindernotOpenedTickets();
  }

  @Query(() => Audit, { name: 'audit' })
  findOne(@Args('id', { type: () => Int }) id: number) {
    return this.auditService.findOne(id);
  }

  @Mutation(() => Audit)
  markReminderAsSeen(@Args('_id') _id: string) {
    return this.auditService.markReminderAsSeen(_id);
  }

  @Mutation(() => Audit)
  removeAudit(@Args('id', { type: () => Int }) id: number) {
    return this.auditService.remove(id);
  }
}
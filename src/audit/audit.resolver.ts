import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { AuditService } from './audit.service';
import { Audit } from './entities/audit.entity';
import { AuditInput } from './dto/create-audit.input';
import { withErrorContext } from '../common/error-context';

@Resolver(() => Audit)
export class AuditResolver {
  constructor(private readonly auditService: AuditService) {}

  @Mutation(() => Audit)
  async createAudit(@Args('createAuditInput') auditInput: AuditInput) {
    try {
      return await this.auditService.create(auditInput);
    } catch (error) {
      throw withErrorContext(error, 'AuditResolver.createAudit');
    }
  }

  @Query(() => [Audit])
  async getAllNotification() {
    try {
      return await this.auditService.getAllNotification();
    } catch (error) {
      throw withErrorContext(error, 'AuditResolver.getAllNotification');
    }
  }

  /** Traces d'audit d'une DI — alimente l'onglet « Liens » du dossier détaillé. */
  @Query(() => [Audit])
  async getAuditByDi(
    @Args('diId') diId: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ) {
    try {
      return await this.auditService.getAuditByDi(diId, limit ?? 200);
    } catch (error) {
      throw withErrorContext(error, 'AuditResolver.getAuditByDi');
    }
  }

  @Query(() => Audit, { name: 'audit' })
  findOne(@Args('id', { type: () => Int }) id: number) {
    try {
      return this.auditService.findOne(id);
    } catch (error) {
      throw withErrorContext(error, 'AuditResolver.findOne');
    }
  }

  @Mutation(() => Audit)
  async markAsSeenNotification(@Args('_id') auditId: string) {
    try {
      return await this.auditService.markAsSeen(auditId);
    } catch (error) {
      throw withErrorContext(error, 'AuditResolver.markAsSeenNotification');
    }
  }

  @Mutation(() => Audit)
  removeAudit(@Args('id', { type: () => Int }) id: number) {
    try {
      return this.auditService.remove(id);
    } catch (error) {
      throw withErrorContext(error, 'AuditResolver.removeAudit');
    }
  }
}

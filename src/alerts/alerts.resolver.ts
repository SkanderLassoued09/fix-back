import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DiAlertService } from './alerts.service';
import { ListAlertsInput } from './dto/alert.input';
import { DiAlert, DiAlertDocument } from './entities/di-alert.entity';
import { withErrorContext } from '../common/error-context';

@Resolver(() => DiAlert)
export class DiAlertResolver {
  constructor(private readonly alertService: DiAlertService) {}

  /**
   * Operational alerts feed. Frontend dashboards/inboxes use this both for
   * the initial load and when a websocket event hints there's something new.
   */
  @Query(() => [DiAlert])
  async listDiAlerts(
    @Args('input', { nullable: true }) input?: ListAlertsInput,
  ): Promise<DiAlert[]> {
    try {
      const docs = await this.alertService.listAlerts(input ?? {});
      return docs.map((d) => this.toGraphQL(d));
    } catch (error) {
      throw withErrorContext(error, 'DiAlertResolver.listDiAlerts');
    }
  }

  @Mutation(() => DiAlert, { nullable: true })
  async resolveDiAlert(
    @Args('alertId') alertId: string,
    @Args('resolvedBy', { nullable: true }) resolvedBy?: string,
  ): Promise<DiAlert | null> {
    try {
      const updated = await this.alertService.resolveAlert(
        alertId,
        resolvedBy ?? null,
      );
      return updated ? this.toGraphQL(updated) : null;
    } catch (error) {
      throw withErrorContext(error, 'DiAlertResolver.resolveDiAlert');
    }
  }

  private toGraphQL(doc: DiAlertDocument): DiAlert {
    try {
      return {
        _id: doc._id as string,
        diId: doc.diId,
        type: doc.type,
        severity: doc.severity,
        message: doc.message,
        assignedRoles: doc.assignedRoles,
        metadataJson: doc.metadata ? JSON.stringify(doc.metadata) : undefined,
        escalationLevel: doc.escalationLevel,
        resolvedAt: doc.resolvedAt ?? undefined,
        resolvedBy: doc.resolvedBy ?? undefined,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    } catch (error) {
      throw withErrorContext(error, 'DiAlertResolver.toGraphQL');
    }
  }
}

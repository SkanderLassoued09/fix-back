import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { StatService } from 'src/stat/stat.service';
import { Di, DiDocument } from '../entities/di.entity';
import { DI_TRANSITIONS } from './di-transition.map';
import {
  DiTransitionConfig,
  DiTransitionInput,
  DiTransitionResult,
} from './di-workflow.types';

type WorkflowLogPayload = {
  event: string;
  category?: string;
  transitionKey?: string;
  diId?: string;
  previousStatus?: string;
  nextStatus?: string;
  actorRole?: string;
  actorId?: string;
  validationMode?: 'soft' | 'strict';
  timestamp: string;
  details?: Record<string, unknown>;
};

@Injectable()
export class DiWorkflowService {
  private readonly logger = new Logger(DiWorkflowService.name);

  constructor(
    @InjectModel(Di.name) private readonly diModel: Model<DiDocument>,
    private readonly statsService: StatService,
  ) {}

  async transition(input: DiTransitionInput): Promise<DiTransitionResult<Di>> {
    const config = this.getTransitionConfig(input.transitionKey);
    const di = await this.diModel.findOne({ _id: input.diId });

    if (!di) {
      throw new NotFoundException(`DI ${input.diId} not found`);
    }

    this.softValidateFromStatus(di.status, config, input);
    this.softValidateActorRole(config, input);

    const update: Record<string, unknown> = {
      status: config.to,
    };

    if (config.currentRoles) {
      update.current_roles = config.currentRoles;
    }

    const updatedDi = await this.diModel.findOneAndUpdate(
      { _id: input.diId },
      { $set: update },
      { new: true },
    );

    if (!updatedDi) {
      throw new NotFoundException(`DI ${input.diId} not found after transition`);
    }

    if (config.updateStatStatus) {
      try {
        await this.updateStatStatus(updatedDi, config.to);
      } catch (error) {
        this.logStatSyncFailure(config, input, di.status, error);
        throw error;
      }
    }

    this.logTransitionSuccess(config, input, di.status);

    return {
      di: updatedDi as unknown as Di,
      previousStatus: di.status,
      nextStatus: config.to,
      transitionKey: config.key,
    };
  }

  private getTransitionConfig(transitionKey: string): DiTransitionConfig {
    const config = DI_TRANSITIONS[transitionKey];

    if (!config) {
      // Unknown transition keys are implementation errors, not legacy behavior.
      this.logMissingTransitionConfig(transitionKey);
      throw new Error(`Unknown DI transition '${transitionKey}'`);
    }

    return config;
  }

  private softValidateFromStatus(
    currentStatus: string,
    config: DiTransitionConfig,
    input: DiTransitionInput,
  ) {
    if (!config.from?.length || input.skipFromValidation) {
      return;
    }

    const isAllowed = config.from.includes(currentStatus);

    if (!isAllowed) {
      const message = `DI transition '${config.key}' expected one of [${config.from.join(
        ', ',
      )}] but got '${currentStatus}' for DI ${input.diId}`;

      if (config.strictFrom) {
        // TODO: replace with a domain-specific exception after strict migration.
        throw new Error(message);
      }

      this.logger.warn(
        this.formatLog({
          event: 'di.workflow.validation.warning',
          category: 'workflow.invalid_source_status',
          transitionKey: config.key,
          diId: input.diId,
          previousStatus: currentStatus,
          nextStatus: config.to,
          actorRole: input.actorRole,
          actorId: input.actorId,
          validationMode: this.getValidationMode(config),
          timestamp: this.getTimestamp(),
          details: {
            expectedStatuses: config.from,
            message,
          },
        }),
      );
    }
  }

  private softValidateActorRole(
    config: DiTransitionConfig,
    input: DiTransitionInput,
  ) {
    if (
      !config.allowedActorRoles?.length ||
      !input.actorRole ||
      input.skipRoleValidation
    ) {
      return;
    }

    const isAllowed = config.allowedActorRoles.includes(input.actorRole);

    if (!isAllowed) {
      const message = `DI transition '${config.key}' expected actor role one of [${config.allowedActorRoles.join(
        ', ',
      )}] but got '${input.actorRole}' for DI ${input.diId}`;

      if (config.strictRole) {
        // TODO: replace with ForbiddenException after resolvers consistently pass actor role.
        throw new Error(message);
      }

      this.logger.warn(
        this.formatLog({
          event: 'di.workflow.validation.warning',
          category: 'workflow.invalid_actor_role',
          transitionKey: config.key,
          diId: input.diId,
          nextStatus: config.to,
          actorRole: input.actorRole,
          actorId: input.actorId,
          validationMode: this.getValidationMode(config),
          timestamp: this.getTimestamp(),
          details: {
            allowedActorRoles: config.allowedActorRoles,
            message,
          },
        }),
      );
    }
  }

  private async updateStatStatus(di: DiDocument, status: string) {
    if (di.ignoreCount && di.ignoreCount > 0) {
      await this.statsService.updateStatus(di._id, status, di.ignoreCount);
      return;
    }

    await this.statsService.updateStatus(di._id, status);
  }

  private logTransitionSuccess(
    config: DiTransitionConfig,
    input: DiTransitionInput,
    previousStatus: string,
  ) {
    this.logger.log(
      this.formatLog({
        event: 'di.workflow.transition.success',
        category: 'workflow.transition_success',
        transitionKey: config.key,
        diId: input.diId,
        previousStatus,
        nextStatus: config.to,
        actorRole: input.actorRole,
        actorId: input.actorId,
        validationMode: this.getValidationMode(config),
        timestamp: this.getTimestamp(),
      }),
    );
  }

  private logMissingTransitionConfig(transitionKey: string) {
    this.logger.error(
      this.formatLog({
        event: 'di.workflow.config.error',
        category: 'workflow.missing_transition_config',
        transitionKey,
        validationMode: 'soft',
        timestamp: this.getTimestamp(),
      }),
    );
  }

  private logStatSyncFailure(
    config: DiTransitionConfig,
    input: DiTransitionInput,
    previousStatus: string,
    error: unknown,
  ) {
    this.logger.error(
      this.formatLog({
        event: 'di.workflow.side_effect.error',
        category: 'workflow.stat_sync_failed',
        transitionKey: config.key,
        diId: input.diId,
        previousStatus,
        nextStatus: config.to,
        actorRole: input.actorRole,
        actorId: input.actorId,
        validationMode: this.getValidationMode(config),
        timestamp: this.getTimestamp(),
        details: {
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  }

  private getValidationMode(config: DiTransitionConfig): 'soft' | 'strict' {
    return config.strictFrom || config.strictRole ? 'strict' : 'soft';
  }

  private getTimestamp(): string {
    return new Date().toISOString();
  }

  private formatLog(payload: WorkflowLogPayload): string {
    return JSON.stringify(payload);
  }
}

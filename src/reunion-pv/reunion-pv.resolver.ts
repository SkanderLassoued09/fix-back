import { Args, Mutation, Query, Resolver, Context } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import {
  CreateReunionPVInput,
  UpdateReunionPVDetailsInput,
} from './dto/reunion-pv.input';
import { ReunionPV } from './entities/reunion-pv.entity';
import { ReunionPVService } from './reunion-pv.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { RolesGuard } from 'src/auth/role-guard';
import { Role, Roles } from 'src/profile/role-decorator';
import { withErrorContext } from '../common/error-context';

/**
 * Rôles autorisés à gérer les Réunions (menu, route, ET création serveur) :
 * admin (gestion + technique), manager, coordinateur. `COORDIANTOR` est la
 * valeur RÉELLEMENT persistée (typo historique) — voir role-decorator.
 */
const REUNION_ROLES = [
  Role.ADMIN_MANAGER,
  Role.ADMIN_TECH,
  Role.MANAGER,
  Role.COORDIANTOR,
];

@Resolver(() => ReunionPV)
export class ReunionPVResolver {
  constructor(private readonly service: ReunionPVService) {}

  /**
   * Create a PV. The frontend MUST pass `createdById` (read from
   * `localStorage._id`) — we don't rely on the JWT-derived @CurrentUser
   * because that decorator path is unreliable in this codebase. The
   * `x-test-run: 1` header (sent by QA traffic) makes the service skip
   * the Discord post AND the Jira issue creation so test runs never spam the
   * channel or create throwaway issues in the real Jira project.
   */
  @Mutation(() => ReunionPV)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REUNION_ROLES)
  async createReunionPV(
    @Args('input') input: CreateReunionPVInput,
    @Context() ctx: any,
  ) {
    try {
      const headers = ctx?.req?.headers ?? {};
      const testRun =
        String(headers['x-test-run'] ?? headers['X-Test-Run'] ?? '') === '1';
      return await this.service.create(input, {
        skipDiscord: testRun,
        skipJira: testRun,
      });
    } catch (error) {
      throw withErrorContext(error, 'ReunionPVResolver.createReunionPV');
    }
  }

  /**
   * Phase-2 "document the meeting" write — fills the detailed sections from the
   * detail modal and pushes each action to Jira (idempotent). Like create, the
   * `x-test-run: 1` header skips the Jira side-effect on QA traffic.
   */
  @Mutation(() => ReunionPV)
  async updateReunionPVDetails(
    @Args('input') input: UpdateReunionPVDetailsInput,
    @Context() ctx: any,
  ) {
    try {
      const headers = ctx?.req?.headers ?? {};
      const testRun =
        String(headers['x-test-run'] ?? headers['X-Test-Run'] ?? '') === '1';
      return await this.service.updateReunionDetails(input, {
        skipJira: testRun,
      });
    } catch (error) {
      throw withErrorContext(error, 'ReunionPVResolver.updateReunionPVDetails');
    }
  }

  @Query(() => ReunionPV)
  async reunionPV(@Args('_id') _id: string) {
    try {
      return await this.service.findById(_id);
    } catch (error) {
      throw withErrorContext(error, 'ReunionPVResolver.reunionPV');
    }
  }

  /**
   * List PVs filtered by `diId` OR `createdById`. With no filter, returns
   * the full list capped at 200 rows (newest first) — used by the
   * "Réunions" sidebar menu.
   */
  @Query(() => [ReunionPV])
  async reunionPVs(
    @Args('diId', { nullable: true }) diId?: string,
    @Args('createdById', { nullable: true }) createdById?: string,
  ) {
    try {
      if (diId) return await this.service.findByDi(diId);
      if (createdById) return await this.service.findByCreatedBy(createdById);
      return await this.service.findAll();
    } catch (error) {
      throw withErrorContext(error, 'ReunionPVResolver.reunionPVs');
    }
  }
}

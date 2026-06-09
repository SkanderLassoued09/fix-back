import { Role } from 'src/auth/roles';
import { STATUS_DI } from '../di.status';
import { DiTransitionConfig } from './di-workflow.types';

export const DI_TRANSITIONS = {
  /**
   * Existing mutation: manager_Pending1
   * Existing behavior: update status + current_roles only.
   *
   * Keep exact status strings and exact current_roles value from STATUS_DI.
   */
  MANAGER_TO_PENDING1: {
    key: 'MANAGER_TO_PENDING1',
    from: [STATUS_DI.Created.status],
    to: STATUS_DI.Pending1.status,
    currentRoles: STATUS_DI.Pending1.role,
    allowedActorRoles: [Role.MANAGER, Role.ADMIN_MANAGER],
    updateStatStatus: false,
    strictFrom: false,
    strictRole: false,
  },
  /**
   * Existing mutation: magasinTech_Pending2
   * Existing behavior: update status + current_roles only.
   *
   * This intentionally does not update Stat.status yet because the legacy
   * method did not call StatService.
   */
  MAGASIN_TECH_TO_PENDING2: {
    key: 'MAGASIN_TECH_TO_PENDING2',
    from: [
      STATUS_DI.InMagasin.status,
      STATUS_DI.InDiagnostic.status,
      STATUS_DI.MagasinEstimation.status,
    ],
    to: STATUS_DI.Pending2.status,
    currentRoles: STATUS_DI.Pending2.role,
    allowedActorRoles: [Role.MAGASIN, Role.TECH],
    updateStatStatus: false,
    strictFrom: false,
    strictRole: false,
  },
  /**
   * Existing mutation: managerAdminManager_Pending3
   * Existing behavior: update status + current_roles only.
   */
  MANAGER_ADMIN_TO_PENDING3: {
    key: 'MANAGER_ADMIN_TO_PENDING3',
    from: [STATUS_DI.Negotiation1.status, STATUS_DI.Negotiation2.status],
    to: STATUS_DI.Pending3.status,
    currentRoles: STATUS_DI.Pending3.role,
    allowedActorRoles: [Role.MANAGER, Role.ADMIN_MANAGER],
    updateStatStatus: false,
    strictFrom: false,
    strictRole: false,
  },
  /**
   * Existing mutation: changeStatusInDiagnostic
   * Existing behavior: update DI.status, synchronize Stat.status with the same
   * ignoreCount behavior, then DiService sends the legacy socket notification.
   *
   * No current_roles update here: the legacy method only changed status.
   */
  CHANGE_STATUS_IN_DIAGNOSTIC: {
    key: 'CHANGE_STATUS_IN_DIAGNOSTIC',
    from: [
      STATUS_DI.Diagnostic.status,
      STATUS_DI.DiagnosticInPause.status,
      STATUS_DI.Pending1.status,
    ],
    to: STATUS_DI.InDiagnostic.status,
    allowedActorRoles: [Role.TECH],
    updateStatStatus: true,
    strictFrom: false,
    strictRole: false,
  },
  /**
   * Mutation: changeStatusInRepair
   * Behavior mirror of CHANGE_STATUS_IN_DIAGNOSTIC for the repair flow:
   * Reparation / ReparationInPause / Pending3 → InReparation, both DI and
   * the matching Stat. Same updateStatStatus + soft validation defaults so
   * the rep resume goes through the exact same code path the diag resume
   * uses (which the user verified is working in production).
   */
  CHANGE_STATUS_IN_REPAIR: {
    key: 'CHANGE_STATUS_IN_REPAIR',
    from: [
      STATUS_DI.Reparation.status,
      STATUS_DI.ReparationInPause.status,
      STATUS_DI.Pending3.status,
    ],
    to: STATUS_DI.InReparation.status,
    allowedActorRoles: [Role.TECH],
    updateStatStatus: true,
    strictFrom: false,
    strictRole: false,
  },
} satisfies Record<string, DiTransitionConfig>;

export type DiTransitionKey = keyof typeof DI_TRANSITIONS;

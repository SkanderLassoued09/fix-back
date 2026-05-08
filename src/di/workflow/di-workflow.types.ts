export type DiStatus = string;
export type DiRole = string;

export interface DiTransitionConfig {
  /**
   * Stable internal transition key. This is not exposed in the current GraphQL
   * schema; existing mutations can delegate to these keys incrementally.
   */
  key: string;
  /**
   * Allowed source statuses. Kept soft initially so legacy flows are observed
   * before they are blocked.
   */
  from?: DiStatus[];
  to: DiStatus;
  currentRoles?: DiRole[];
  allowedActorRoles?: DiRole[];
  /**
   * Some old methods only update DI, while others also synchronize Stat.status.
   * Keep this explicit to preserve existing behavior during migration.
   */
  updateStatStatus?: boolean;
  /**
   * TODO: turn this on transition-by-transition after tests confirm the legacy
   * frontend never depends on looser behavior.
   */
  strictFrom?: boolean;
  /**
   * TODO: turn this on only after the corresponding resolver passes actor role
   * from the authenticated profile.
   */
  strictRole?: boolean;
}

export interface DiTransitionInput {
  diId: string;
  transitionKey: string;
  actorId?: string;
  actorRole?: DiRole;
  /**
   * Compatibility flags used while existing mutations are migrated one by one.
   */
  skipFromValidation?: boolean;
  skipRoleValidation?: boolean;
}

export interface DiTransitionResult<TDi = any> {
  di: TDi;
  previousStatus?: DiStatus;
  nextStatus: DiStatus;
  transitionKey: string;
}

import { registerEnumType } from '@nestjs/graphql';

/**
 * Reason a DI is currently blocked from progressing. This is *metadata*
 * attached to a DI document — it does NOT replace the workflow status
 * (CREATED → PENDING1 → … → FINISHED). A DI can sit in any waiting status
 * (e.g. PENDING2, MAGASIN, RETOUR1) and additionally carry a blockedReason
 * so dashboards and alerts can act on it without changing the workflow.
 */
////excel ...
export enum BlockedReason {
  MISSING_COMPONENT = 'MISSING_COMPONENT',
  WAITING_CUSTOMER = 'WAITING_CUSTOMER',
  WAITING_APPROVAL = 'WAITING_APPRO VAL',
  WAITING_TECHNICIAN = 'WAITING_TECHNICIAN',
  OTHER = 'OTHER',
}

registerEnumType(BlockedReason, {
  name: 'BlockedReason',
  description:
    'Soft block reason attached to a DI in addition to its workflow status.',
});

export const BLOCKED_REASON_VALUES: string[] = Object.values(BlockedReason);

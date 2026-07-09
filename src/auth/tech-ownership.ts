/**
 * Technician ownership rule — the single source of truth for "does this DI
 * belong to the acting technician?", shared by the backend guard and mirrored
 * by the frontend (fix-front/.../tech-di-list/tech-ownership.util.ts).
 *
 * Why not a plain `stat.id_tech_rep === user._id`?
 *  - Identity is stored inconsistently across the historical data set: a DI's
 *    assigned-technician field usually holds the Profile `_id` (Mongo ObjectId
 *    serialized to hex), but some records / flows persist the `username`. The
 *    server-side list filter matches on `_id` (so a TECH only ever sees rows
 *    where `_id` matches), which is why the plain check "works" for a TECH but
 *    silently greys an ADMIN_TECH whose owned DIs were stored under a different
 *    identity token. Matching either `_id` OR `username` (both normalized)
 *    closes that gap without loosening security — usernames are unique.
 *  - Values arrive as ObjectId, string, or (defensively) a populated object;
 *    normalizing to a trimmed string makes the comparison type-safe.
 */

export interface TechIdentity {
  _id?: unknown;
  username?: unknown;
  role?: unknown;
}

/** Which technician slot a work-action reads on the Stat. */
export type TechAssignmentKind = 'diag' | 'rep';

/** Coerce an id/name/object identity value to a comparable trimmed string. */
export function normalizeIdentity(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const nested = obj._id ?? obj.username ?? obj.id;
    if (nested !== null && nested !== undefined) {
      return normalizeIdentity(nested);
    }
    // Raw ObjectId / Buffer / etc. → its own string form (hex).
    return String(value).trim();
  }
  return String(value).trim();
}

/**
 * True when `assigned` (the value stored in id_tech_diag / id_tech_rep)
 * identifies `user`. Matches on Profile `_id` OR `username`, both normalized.
 * An empty/unknown `assigned` never matches (a DI with no assignee is not
 * "owned" by anyone).
 */
export function techIdentityMatches(
  assigned: unknown,
  user: TechIdentity | undefined | null,
): boolean {
  if (!user) {
    return false;
  }
  const target = normalizeIdentity(assigned);
  if (target === '') {
    return false;
  }
  const id = normalizeIdentity(user._id);
  const username = normalizeIdentity(user.username);
  return (id !== '' && target === id) || (username !== '' && target === username);
}

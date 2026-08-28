/**
 * ALIGNEMENT du vocabulaire de rôles — SOURCE UNIQUE.
 *
 * Deux vocabulaires cohabitent dans le code :
 *   - « humain » : `STATUS_DI.role` et `di_alerts.assignedRoles`
 *     (`Coordinator`, `Manager`, `Admin_Manager`, `Magasin`, `Tech`, `Admin_Tech`) ;
 *   - « enum profil » : la valeur RÉELLE stockée sur `profiles.role`.
 *
 * ⚠️ La valeur réelle du coordinateur est **`COORDIANTOR`** (COQUILLE figée en
 * base sur tous les profils). On NE la corrige PAS : un renommage sans migration
 * casserait les permissions partout. Ce mapping S'ALIGNE sur la valeur stockée,
 * coquille comprise. (NB : `Role.COORDINATOR = 'COORDINATOR'` dans `auth/roles.ts`
 * est lui-même désaligné de la base — ne pas s'en servir pour cibler.)
 *
 * Tout ciblage par rôle du système de notifications passe par `toProfileRoles()`.
 */

/** Valeurs d'enum profil RÉELLES telles que stockées en base. */
export const PROFILE_ROLE_VALUES = [
  'ADMIN_MANAGER',
  'ADMIN_TECH',
  'MANAGER',
  'TECH',
  'MAGASIN',
  'COORDIANTOR', // coquille réelle (pas 'COORDINATOR')
] as const;

const PROFILE_ROLE_SET = new Set<string>(PROFILE_ROLE_VALUES);

/** Vocabulaire « humain » → valeur profil réelle. */
export const HUMAN_ROLE_TO_PROFILE_ROLE: Record<string, string> = {
  Admin_Manager: 'ADMIN_MANAGER',
  Admin_Tech: 'ADMIN_TECH',
  Coordinator: 'COORDIANTOR', // ← coquille réelle en base
  Magasin: 'MAGASIN',
  Manager: 'MANAGER',
  Tech: 'TECH',
};

/**
 * Résout un rôle (humain OU déjà profil) en valeur profil réelle.
 * Idempotent : une valeur profil déjà correcte est renvoyée telle quelle.
 * Retourne `null` si le rôle n'est pas reconnu (jamais deviné).
 */
export function toProfileRole(role: string | null | undefined): string | null {
  if (!role) return null;
  if (PROFILE_ROLE_SET.has(role)) return role; // déjà une valeur profil
  if (HUMAN_ROLE_TO_PROFILE_ROLE[role]) return HUMAN_ROLE_TO_PROFILE_ROLE[role];
  return null; // inconnu → non résolu (l'appelant loggue, ne devine pas)
}

/**
 * Résout une liste de rôles, en séparant explicitement les non résolus pour un
 * traitement NON silencieux (log + historique conservé, badge non gonflé).
 */
export function toProfileRoles(roles: string[]): {
  resolved: string[];
  unresolved: string[];
} {
  const resolved = new Set<string>();
  const unresolved: string[] = [];
  for (const r of roles ?? []) {
    const m = toProfileRole(r);
    if (m) resolved.add(m);
    else unresolved.push(r);
  }
  return { resolved: [...resolved], unresolved };
}

import { SetMetadata } from '@nestjs/common';
// import { Role } from 'src/auth/roles';
// import { Role } from './roles.enum';

export enum Role {
  ADMIN_MANAGER = 'ADMIN_MANAGER',
  ADMIN_TECH = 'ADMIN_TECH',
  MANAGER = 'MANAGER',
  TECH = 'TECH',
  MAGASIN = 'MAGASIN',
  // ⚠️ Valeur PERSISTÉE réellement en base + dans le menu front (typo
  // historique « COORDIANTOR », voir known-issues D5). Le JWT porte donc
  // `role: 'COORDIANTOR'` — le RolesGuard doit comparer à CETTE valeur, pas à
  // « COORDINATOR ». Ne pas renommer sans migration de la collection profiles.
  COORDIANTOR = 'COORDIANTOR',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

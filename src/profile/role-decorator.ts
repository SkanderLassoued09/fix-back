import { SetMetadata } from '@nestjs/common';
// import { Role } from 'src/auth/roles';
// import { Role } from './roles.enum';

export enum Role {
  ADMIN_MANAGER = 'ADMIN_MANAGER',
  ADMIN_TECH = 'ADMIN_TECH',
  MANAGER = 'MANAGER',
  TECH = 'TECH',
  MAGASIN = 'MAGASIN',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

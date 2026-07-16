import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';

import { Role } from './roles';
import { ROLES_KEY } from 'src/profile/role-decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // undefined
    if (!requiredRoles) {
      return true;
    }

    const ctx = GqlExecutionContext.create(context);
    const user = ctx.getContext().req?.user;
    // Défensif : `JwtAuthGuard.handleRequest` ne lève PAS sur un token
    // absent/invalide (bug S12) → `user` peut être undefined. Sans cette garde,
    // `user.role` planterait (500) au lieu d'un refus propre. Pas d'utilisateur
    // ⇒ pas de rôle ⇒ accès refusé (Forbidden).
    if (!user || !user.role) {
      return false;
    }
    return requiredRoles.some((role) => role === user.role);
  }
}

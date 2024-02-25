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

    console.log(requiredRoles, 'roles auth guard'); // undefined
    if (!requiredRoles) {
      return true;
    }

    const ctx = GqlExecutionContext.create(context);
    console.log(ctx, 'ctx');
    const user = ctx.getContext().req.user;
    console.log(user, 'user');
    const userRole = user.role;
    console.log(userRole, 'userRole');

    return requiredRoles.some((role) => {
      console.log(role, 'role in fun');
      if (role === userRole) {
        return true;
      } else {
        return false;
      }
    });
  }
}

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * Injects the authenticated user (`req.user`, populated by JwtStrategy)
 * into a resolver / controller param.
 *
 * Was previously `(data, req) => req.user` — that signature is wrong:
 * NestJS passes the `ExecutionContext` as the 2nd arg, NOT the request,
 * so calling `.user` on it returned `undefined`. For GraphQL resolvers,
 * the request lives at `GqlExecutionContext.getContext().req`. The fall-
 * back to plain HTTP path is kept so any REST controller still works.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    // GraphQL request first (this app's normal path).
    try {
      const gqlCtx = GqlExecutionContext.create(context).getContext();
      const fromReq = gqlCtx?.req?.user;
      const fromCtx = gqlCtx?.user;
      if (fromReq) return fromReq;
      if (fromCtx) return fromCtx;
    } catch {
      // Pas un contexte GraphQL — on tente le repli REST ci-dessous.
    }
    // REST fallback (defensive — current app is GraphQL-only).
    try {
      return context.switchToHttp().getRequest()?.user;
    } catch {
      return undefined;
    }
  },
);

export const GetUser = createParamDecorator(
  (_data, context: ExecutionContext) => {
    const ctx = GqlExecutionContext.create(context).getContext();
    return ctx.user;
  },
);

export const User = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const gqlCtx = GqlExecutionContext.create(ctx);
    const request = gqlCtx.getContext().req;
    return request?.user;
  },
);

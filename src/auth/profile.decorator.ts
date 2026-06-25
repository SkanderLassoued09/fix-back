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
      console.log(
        '[CurrentUser] gqlCtx.req.user =',
        JSON.stringify(fromReq),
        ' gqlCtx.user =',
        JSON.stringify(fromCtx),
      );
      if (fromReq) return fromReq;
      if (fromCtx) return fromCtx;
    } catch (e) {
      console.log('[CurrentUser] not gql context:', (e as Error)?.message);
    }
    // REST fallback (defensive — current app is GraphQL-only).
    try {
      const httpUser = context.switchToHttp().getRequest()?.user;
      console.log('[CurrentUser] http fallback user =', JSON.stringify(httpUser));
      return httpUser;
    } catch {
      console.log('[CurrentUser] returning undefined');
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

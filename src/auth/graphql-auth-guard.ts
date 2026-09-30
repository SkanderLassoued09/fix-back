import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GqlExecutionContext } from '@nestjs/graphql';

import { Observable } from 'rxjs';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { withErrorContext } from '../common/error-context';

@Injectable()
export class GraphqlAuthGuard extends AuthGuard('jwt') {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    try {
      const ctx = GqlExecutionContext.create(context);
      const { req } = ctx.getContext();
      return super.canActivate(new ExecutionContextHost([req]));
    } catch (error) {
      throw withErrorContext(error, 'GraphqlAuthGuard.canActivate');
    }
  }
}

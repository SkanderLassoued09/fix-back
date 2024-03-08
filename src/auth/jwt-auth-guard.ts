import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthGuard } from '@nestjs/passport';
import { AuthenticationError } from 'apollo-server-express';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext) {
    const ctx = GqlExecutionContext.create(context);
    const request = ctx.getContext().req;
    if (!request) {
      throw new AuthenticationError('Not Authaurized');
    }
    return request;
  }

  handleRequest(err: any, user: any) {
    if (user) {
      return user;
    }
  }
}

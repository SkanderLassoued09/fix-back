import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthGuard } from '@nestjs/passport';
import { withErrorContext } from '../common/error-context';

@Injectable()
export class GqlAuthGuard extends AuthGuard('local') {
  constructor() {
    super();
  }
  getRequest(context: ExecutionContext) {
    try {
      const ctx = GqlExecutionContext.create(context);
      const request = ctx.getContext().req;
      request.body = ctx.getArgs().loginAuthInput;
      if (!request) {
        throw new UnauthorizedException('You are not allowed');
      }
      return request;
    } catch (error) {
      throw withErrorContext(error, 'GqlAuthGuard.getRequest');
    }
  }
}

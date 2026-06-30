import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * REST-flavoured JWT guard.
 *
 * The app's primary `JwtAuthGuard` overrides `getRequest()` to pull the request
 * out of the **GraphQL** execution context — so it throws on a plain HTTP route.
 * REST controllers (the bulk DI import endpoint) need the default passport
 * behaviour, which reads the request from `switchToHttp()`. The shared
 * `passport-jwt` strategy (Bearer token → `{ _id, ... }` on `req.user`) is
 * reused as-is; only the context extraction differs, hence this thin subclass.
 */
@Injectable()
export class RestJwtAuthGuard extends AuthGuard('jwt') {}

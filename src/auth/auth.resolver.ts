import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { AuthService } from './auth.service';
import { Auth } from './entities/auth.entity';
import { LoginAuthInput, LoginResponse } from './dto/create-auth.input';
import { UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from './gql-auth-guard';

@Resolver(() => Auth)
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => LoginResponse)
  @UseGuards(GqlAuthGuard)
  async login(@Args('loginAuthInput') loginAuthInput: LoginAuthInput) {
    return this.authService.login(loginAuthInput);
  }

  /**
   * Logout — the caller passes its JWT explicitly as an arg; the service
   * verifies it with JwtService and extracts `_id`. We bypass
   * `@UseGuards(JwtAuthGuard)` + `@CurrentUser()` because the existing
   * decorator wiring was returning `undefined` for this resolver, leaving
   * the `isConnected` flag stuck at true. Token-in-arg is the simplest
   * reliable path: no guard timing, no decorator extraction — just verify
   * + read `_id`.
   *
   * Returns true when the flag was flipped (or already false), false on
   * an invalid / unparsable token (treated as a no-op rather than an
   * error since the caller's session is going away anyway).
   */
  @Mutation(() => Boolean)
  async logout(@Args('token') token: string) {
    return this.authService.logout({ token });
  }
}

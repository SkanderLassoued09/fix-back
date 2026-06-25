import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LoginAuthInput } from './dto/create-auth.input';
import { ProfileService } from 'src/profile/profile.service';
import { ProfileDocument } from 'src/profile/entities/profile.entity';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';

// Dedicated error code surfaced to the frontend so it can render the
// "déjà connecté sur un autre appareil" banner instead of a generic auth
// failure message. The code travels in HttpException's message body.
export const ACCOUNT_ALREADY_CONNECTED = 'ACCOUNT_ALREADY_CONNECTED';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel('Profile') private profileModel: Model<ProfileDocument>,
    private profileService: ProfileService,
    private jwtService: JwtService,
  ) {}

  /**
   * Used by the local Passport strategy at login. Looks up the user by
   * username and verifies the password. Throws specific French errors
   * for unknown user / wrong password (consumed by GqlAuthGuard).
   */
  async validateUser(username: string, password: string): Promise<any> {
    const user = await this.profileService.findOneForAuth(username);
    if (!user) {
      throw new HttpException(
        `Nom d'utilisateur inexistant`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const matchPassword = await bcrypt.compare(password, user.password);
    if (!matchPassword) {
      throw new HttpException(
        'Mot de passe est incorrect',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const { password: _pw, ...result } = user as any;
    return result;
  }

  async login(loginAuthInput: LoginAuthInput) {
    const user = await this.profileService.findOneForAuth(
      loginAuthInput.username,
    );

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // ── Single-session enforcement, minimal version ────────────────────
    // One boolean drives everything: `isConnected: true` → an active
    // session exists → block. `false` → free → allow + flip true. No
    // heartbeat, no loginId, no stale window. Closed tabs without an
    // explicit logout will leave the flag true; the frontend's
    // `pagehide` hook fires a best-effort logout to mitigate that.
    if (user.isConnected) {
      throw new HttpException(ACCOUNT_ALREADY_CONNECTED, HttpStatus.CONFLICT);
    }

    await this.profileModel.updateOne(
      { _id: user._id },
      { $set: { isConnected: true } },
    );

    const refreshed = (await this.profileService.findOneForAuth(
      loginAuthInput.username,
    )) as any;
    return {
      access_token: this.jwtService.sign({
        email: refreshed.email,
        username: refreshed.username,
        role: refreshed.role,
        _id: refreshed._id,
      }),
      user: refreshed,
    };
  }

  /**
   * Logout — takes the JWT directly (passed as a GraphQL arg from the
   * frontend) and verifies it with JwtService. Avoids the @CurrentUser
   * decorator path that was returning undefined and leaving the flag
   * stuck at true. The token's `_id` claim is the source of truth.
   *
   * Returns false on an invalid / expired / unparsable token — treated as
   * a no-op so a stale logout call can never throw a 500 at the user.
   */
  async logout(payload: { token: string }): Promise<boolean> {
    console.log(
      '[AuthService.logout] token len =',
      payload?.token?.length ?? 0,
    );
    if (!payload?.token) {
      console.log('[AuthService.logout] no token → returning false');
      return false;
    }
    let _id: string | undefined;
    try {
      const decoded: any = this.jwtService.verify(payload.token);
      _id = decoded?._id;
      console.log('[AuthService.logout] decoded _id =', _id);
    } catch (e) {
      console.log(
        '[AuthService.logout] token verify failed:',
        (e as Error)?.message,
      );
      return false;
    }
    if (!_id) {
      console.log('[AuthService.logout] decoded payload had no _id');
      return false;
    }
    const writeResult = await this.profileModel.updateOne(
      { _id },
      { $set: { isConnected: false } },
    );
    console.log(
      '[AuthService.logout] updateOne result =',
      JSON.stringify(writeResult),
    );
    return true;
  }
}

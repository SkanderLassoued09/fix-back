import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from './auth.service';
import { withErrorContext } from '../common/error-context';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({ usernameField: 'username' });
  }

  async validate(username: string, password: string): Promise<any> {
    try {
      const profile = await this.authService.validateUser(username, password);
      if (!profile) {
        throw new UnauthorizedException('Invalid credentials');
      }
      return await profile;
    } catch (error) {
      throw withErrorContext(error, 'LocalStrategy.validate');
    }
  }
}

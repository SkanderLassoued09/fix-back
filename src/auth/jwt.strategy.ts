import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';

import { ExtractJwt, Strategy } from 'passport-jwt';
import { JWT_SECRET } from './jwt.constants';
import { withErrorContext } from '../common/error-context';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: JWT_SECRET,
    });
  }

  async validate(payload: any) {
    try {
      return {
        _id: payload._id,
        role: payload.role,
        username: payload.username,
        email: payload.email,
      };
    } catch (error) {
      throw withErrorContext(error, 'JwtStrategy.validate');
    }
  }
}

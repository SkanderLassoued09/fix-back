import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthResolver } from './auth.resolver';
import { ProfileModule } from 'src/profile/profile.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { JwtStrategy } from './jwt.strategy';
import { LocalStrategy } from './local.strategy';

@Module({
  imports: [
    ProfileModule,
    PassportModule,
    JwtModule.register({
      signOptions: { expiresIn: '365d' },
      secret: 'hide-me',
    }),
  ],
  providers: [LocalStrategy, AuthService, AuthResolver, JwtStrategy],
})
export class AuthModule {}

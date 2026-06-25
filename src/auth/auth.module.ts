import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthResolver } from './auth.resolver';
import { ProfileModule } from 'src/profile/profile.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MongooseModule } from '@nestjs/mongoose';
import { Profile, ProfileSchema } from 'src/profile/entities/profile.entity';

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
    // AuthService needs direct write access to the Profile collection (set
    // `activeLoginId` / `lastSeenAt` / `isConnected` at login + heartbeat).
    // ProfileService only exposes high-level lookups, so we re-register the
    // model here rather than widening its surface for a one-off use case.
    MongooseModule.forFeature([{ name: Profile.name, schema: ProfileSchema }]),
  ],
  providers: [LocalStrategy, AuthService, AuthResolver, JwtStrategy],
})
export class AuthModule {}

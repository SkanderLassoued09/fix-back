import { Module } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { ProfileResolver } from './profile.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { ProfileSchema } from './entities/profile.entity';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    JwtModule.register({
      signOptions: { expiresIn: '365d' },
      secret: 'hide-me',
    }),
    MongooseModule.forFeature([{ name: 'Profile', schema: ProfileSchema }]),
  ],
  providers: [ProfileService, ProfileResolver],
  exports: [ProfileService],
})
export class ProfileModule {}

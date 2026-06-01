import { Module } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { ProfileResolver } from './profile.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { Profile, ProfileSchema } from './entities/profile.entity';
import { JwtModule } from '@nestjs/jwt';
import { OperationalErrorModule } from 'src/operational-error/operational-error.module';

@Module({
  imports: [
    OperationalErrorModule,
    JwtModule.register({
      signOptions: { expiresIn: '365d' },
      secret: 'hide-me',
    }),
    MongooseModule.forFeature([{ name: Profile.name, schema: ProfileSchema }]),
  ],
  providers: [ProfileService, ProfileResolver],
  exports: [ProfileService],
})
export class ProfileModule {}

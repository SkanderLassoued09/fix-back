import { Module } from '@nestjs/common';
import { DashboardKpiService } from './dashboard-kpi.service';
import { DashboardKpiResolver } from './dashboard-kpi.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { Di, DiSchema } from 'src/di/entities/di.entity';
import { Profile, ProfileSchema } from 'src/profile/entities/profile.entity';
import { Stat, StatSchema } from 'src/stat/entities/stat.entity';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Di.name, schema: DiSchema },
      { name: Profile.name, schema: ProfileSchema },
      { name: Stat.name, schema: StatSchema },
    ]),
  ],
  providers: [DashboardKpiResolver, DashboardKpiService],
})
export class DashboardKpiModule {}

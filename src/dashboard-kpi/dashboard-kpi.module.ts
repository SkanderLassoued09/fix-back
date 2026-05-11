import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardKpiResolver } from './dashboard-kpi.resolver';
import { DashboardKpiService } from './dashboard-kpi.service';
import { TechAnalyticsService } from './tech-analytics.service';
import { Di, DiSchema } from 'src/di/entities/di.entity';
import { Profile, ProfileSchema } from 'src/profile/entities/profile.entity';
import { Stat, StatSchema } from 'src/stat/entities/stat.entity';
import {
  DiCategory,
  DiCategorySchema,
} from 'src/di_category/entities/di_category.entity';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Di.name, schema: DiSchema },
      { name: Profile.name, schema: ProfileSchema },
      { name: Stat.name, schema: StatSchema },
      { name: DiCategory.name, schema: DiCategorySchema },
    ]),
  ],
  providers: [DashboardKpiResolver, DashboardKpiService, TechAnalyticsService],
})
export class DashboardKpiModule {}

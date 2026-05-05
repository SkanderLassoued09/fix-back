import { Injectable } from '@nestjs/common';
import { CreateDashboardKpiInput } from './dto/create-dashboard-kpi.input';
import { UpdateDashboardKpiInput } from './dto/update-dashboard-kpi.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ProfileDocument } from 'src/profile/entities/profile.entity';
import { DiDocument } from 'src/di/entities/di.entity';
import { StatDocument } from 'src/stat/entities/stat.entity';
import { STATUS_DI } from 'src/di/di.status';

@Injectable()
export class DashboardKpiService {
  constructor(
    @InjectModel('Profile') private profileModel: Model<ProfileDocument>,
    @InjectModel('Di') private diModel: Model<DiDocument>,
    @InjectModel('Stat') private statsModel: Model<StatDocument>,
  ) {}

  private async getTauxDiCloture(startDate?: Date, endDate?: Date) {
    const totalDiCloturé = await this.diModel
      .find({ status: STATUS_DI.Finished.status })
      .countDocuments();
    const totalDi = await this.diModel.countDocuments();
    return totalDi ? (totalDiCloturé / totalDi) * 100 : 0;
  }

  private async getTauxDiEnCours(startDate?: Date, endDate?: Date) {
    const excludedStatuses = [
      'CREATED',
      'FINISHED',
      'ANNULER',
      'RETOUR1',
      'RETOUR2',
      'RETOUR3',
    ];

    const totalDiEnCours = await this.diModel.countDocuments({
      status: { $nin: excludedStatuses },
    });
    const totalDi = await this.diModel.countDocuments();
    return totalDi ? (totalDiEnCours / totalDi) * 100 : 0;
  }

  getScoreSatifactionClient(startDate?: Date, endDate?: Date) {
    return 4.2;
  }

  async getDashboardOverview(startDate?: Date, endDate?: Date) {
    const [tauxCloture, tauxEnCours, satisfaction] = await Promise.all([
      this.getTauxDiCloture(startDate, endDate),
      this.getTauxDiEnCours(startDate, endDate),
      this.getScoreSatifactionClient(startDate, endDate),
    ]);
    return {
      atelier: {
        tauxClotures: tauxCloture,
        tauxEnCours: tauxEnCours,
      },
      satisfaction: {
        score: satisfaction,
      },
    };
  }
}

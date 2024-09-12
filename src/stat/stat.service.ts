import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CreateStatInput } from './dto/create-stat.input';
import { InjectModel } from '@nestjs/mongoose';
import { Stat } from './entities/stat.entity';
import { Model } from 'mongoose';
import { Di, DiDocument } from 'src/di/entities/di.entity';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
@Injectable()
export class StatService {
  constructor(
    @InjectModel('Stat') private StatModel: Model<Stat>,
    private readonly notificationGateway: NotificationsGateway,
    private readonly profileService: ProfileService,
  ) {}

  async generateStatId(): Promise<number> {
    let indexStat = 0;
    const lastStat = await this.StatModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastStat) {
      indexStat = +lastStat._id.substring(4);

      return indexStat + 1;
    }

    return indexStat;
  }

  async createStat(createStatInput: CreateStatInput): Promise<Stat> {
    const index = await this.generateStatId();

    createStatInput._id = `STAT${index}`;
    const result = await new this.StatModel(createStatInput).save();

    if (!result) {
      throw new InternalServerErrorException('Unable to create');
    }

    const profile = await this.profileService.findProlileById(
      result.id_tech_diag,
    );

    const payload = { profile, stat: result };
    this.notificationGateway.sendNotificationDiag(payload);

    return result;
  }

  async findUserLinkedToConcernedDi(_idDi: string) {
    return await this.StatModel.findOne({ _idDi });
  }

  async deleteStat(_id: string) {
    console.log('🍆[_id]:', _id);
    const result = await this.StatModel.deleteOne({ _idDi: _id });
    if (result.deletedCount === 0) {
      throw new NotFoundException(
        `Unable to remove stats linked to di with id ${_id}`,
      );
    }

    console.log('🍎 success');
    return result;
  }

  async affectForRep(_idDi: string, _idTech: string) {
    return await this.StatModel.updateOne(
      { _idDi },
      {
        $set: {
          id_tech_rep: _idTech,
        },
      },
    );
  }

  async getDiForTech(_idtech) {
    console.log('🍭[_idtech]:', _idtech);
    return await this.StatModel.find({
      $or: [{ id_tech_diag: _idtech }, { id_tech_rep: _idtech }],
    });
  }

  async lapTime(_id: string, diag_time: string) {
    return await this.StatModel.updateOne(
      { _id },
      {
        $set: {
          diag_time,
        },
      },
    );
  }

  async lapTimeForReaparation(_id: string, rep_time: string) {
    return await this.StatModel.updateOne(
      { _id },
      {
        $set: {
          rep_time,
        },
      },
    );
  }

  async getLastPauseTime(_id: string) {
    return await this.StatModel.findOne({ _id }).exec();
  }
  async getLastPauseTimeForReparation(_id: string) {
    return await this.StatModel.findOne({ _id }).exec();
  }

  async getDIByStat(_idStat: string) {
    try {
      const di = await this.StatModel.findById(_idStat);

      if (!di) throw new Error(`Demande d'intervention with ID  not found.`);

      return di;
    } catch (error) {
      throw error;
    }
  }

  //get by ID_DI
  async getInfoStatByIdDi(_idDi: string) {
    return await this.StatModel.findOne({ _idDi }).exec();
  }

  // update status
  async updateStatus(_id: string, status: string) {
    console.log('🍖[status]:', status);
    console.log('🌶[_id]:', _id);
    const result = await this.StatModel.updateOne(
      { _idDi: _id },
      {
        $set: {
          status,
        },
      },
    );

    return this.getInfoStatByIdDi(_id);
  }
}

import { Injectable } from '@nestjs/common';
import { CreateStatInput } from './dto/create-stat.input';
import { InjectModel } from '@nestjs/mongoose';
import { Stat } from './entities/stat.entity';
import { Model } from 'mongoose';
import { Di, DiDocument } from 'src/di/entities/di.entity';
@Injectable()
export class StatService {
  constructor(@InjectModel('Stat') private StatModel: Model<Stat>) {}

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
    return await new this.StatModel(createStatInput)
      .save()
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
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
}

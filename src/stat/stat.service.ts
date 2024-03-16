import { Injectable } from '@nestjs/common';
import { CreateStatInput } from './dto/create-stat.input';
import { UpdateStatInput } from './dto/update-stat.input';
import { InjectModel } from '@nestjs/mongoose';
import { Stat } from './entities/stat.entity';
import { Model } from 'mongoose';
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
    console.log(index, 'index Stat');
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

  async affectForDiag(_idDi: string, _idTech: string) {
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
}

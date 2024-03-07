import { Injectable } from '@nestjs/common';
import { CreateStatInput } from './dto/create-stat.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Stat } from './entities/stat.entity';

@Injectable()
export class StatsService {
  constructor(@InjectModel('Stat') private StatModel: Model<Stat>) {}

  async generateStatId(): Promise<number> {
    let indexStat = 0;
    const lastStat = await this.StatModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastStat) {
      console.log('is entered');
      indexStat = +lastStat._id.substring(1);
      console.log(indexStat, '== index');
      return indexStat + 1;
    }
    console.log(lastStat, 'lastStat');
    return indexStat;
  }

  async createStat(createStatInput: CreateStatInput): Promise<Stat> {
    const index = await this.generateStatId();
    console.log(index, 'index Stat');
    createStatInput._id = `STAT${index}`;
    return await new this.StatModel(createStatInput)
      .save()
      .then((res) => {
        console.log(res, 'Stat');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
}

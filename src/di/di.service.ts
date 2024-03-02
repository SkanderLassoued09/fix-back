import { Injectable } from '@nestjs/common';
import { CreateDiInput } from './dto/create-di.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Di } from './entities/di.entity';

@Injectable()
export class DiService {
  constructor(@InjectModel('Di') private DiModel: Model<Di>) {}

  async generateDiId(): Promise<number> {
    let indexDi = 0;
    const lastDi = await this.DiModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastDi) {
      console.log('is entered');
      indexDi = +lastDi._id.substring(1);
      console.log(indexDi, '== index');
      return indexDi + 1;
    }
    console.log(lastDi, 'lastDi');
    return indexDi;
  }

  async createDi(createDiInput: CreateDiInput): Promise<Di> {
    const index = await this.generateDiId();
    console.log(index, 'index Di');
    createDiInput._id = `DI${index}`;
    return await new this.DiModel(createDiInput)
      .save()
      .then((res) => {
        console.log(res, 'Di');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
}

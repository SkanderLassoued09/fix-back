import { Injectable } from '@nestjs/common';
import { CreateRemarqueInput } from './dto/create-remarque.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Remarque } from './entities/remarque.entity';

@Injectable()
export class RemarqueService {
  constructor(
    @InjectModel('Remarque') private RemarqueModel: Model<Remarque>,
  ) {}
  async generateRemarqueId(): Promise<number> {
    let indexRemarque = 0;
    const lastRemarque = await this.RemarqueModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastRemarque) {
      console.log('is entered');
      indexRemarque = +lastRemarque._id.substring(1);
      console.log(indexRemarque, '== index');
      return indexRemarque + 1;
    }
    console.log(lastRemarque, 'lastRemarque');
    return indexRemarque;
  }

  async createRemarque(
    createRemarqueInput: CreateRemarqueInput,
  ): Promise<Remarque> {
    const index = await this.generateRemarqueId();
    console.log(index, 'index Remarque');
    createRemarqueInput._id = `Rq${index}`;
    return await new this.RemarqueModel(createRemarqueInput)
      .save()
      .then((res) => {
        console.log(res, 'Remarque');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
}

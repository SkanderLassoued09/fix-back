import { Injectable } from '@nestjs/common';
import { CreateEmplacementInput } from './dto/create-emplacement.input';
import { UpdateEmplacementInput } from './dto/update-emplacement.input';
import { Emplacement } from './entities/emplacement.entity';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Injectable()
export class EmplacementService {
  constructor(
    @InjectModel('Emplacement') private EmplacementModel: Model<Emplacement>,
  ) {}

  async generateEmplacementId(): Promise<number> {
    let indexEmplacement = 0;
    const lastEmplacement = await this.EmplacementModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    console.log(lastEmplacement, 'last ticket');

    if (lastEmplacement) {
      console.log('is entered');
      indexEmplacement = +lastEmplacement._id.substring(1);
      return indexEmplacement + 1;
    }
    return indexEmplacement;
  }

  async createEmplacement(
    createEmplacementInput: CreateEmplacementInput,
  ): Promise<Emplacement> {
    const indexEmplacement = this.generateEmplacementId();
    createEmplacementInput._id = `E${indexEmplacement}`;
    return await new this.EmplacementModel(createEmplacementInput)
      .save()
      .then((res) => {
        console.log(res, 'Emplacement');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
}

import { Injectable } from '@nestjs/common';
import {
  CreateComposantInput,
  UpdateComposantResponse,
} from './dto/create-composant.input';
import { InjectModel } from '@nestjs/mongoose';
import { Composant } from './entities/composant.entity';
import { Model } from 'mongoose';
import { join } from 'path';
import * as fs from 'fs';
import * as randomstring from 'randomstring';
import { getFileExtension } from 'src/di/shared.files';
@Injectable()
export class ComposantService {
  constructor(
    @InjectModel('Composant') private ComposantModel: Model<Composant>,
  ) {}

  async generateComposantId(): Promise<number> {
    let indexComposant = 0;
    const lastComposant = await this.ComposantModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastComposant) {
      indexComposant = +lastComposant._id.substring(3);
      return indexComposant + 1;
    }
    return indexComposant;
  }

  async createComposant(
    createComposantInput: CreateComposantInput,
  ): Promise<Composant> {
    // Check if the PDF is a valid base64 string
    if (
      createComposantInput.pdf &&
      createComposantInput.pdf !== 'null' &&
      createComposantInput.pdf.includes(',')
    ) {
      const extension = getFileExtension(createComposantInput.pdf);
      const buffer = Buffer.from(
        createComposantInput.pdf.split(',')[1], // Split base64 string to get the data
        'base64',
      );

      const randompdfFile = randomstring.generate({
        length: 12,
        charset: 'alphabetic',
      });

      fs.writeFileSync(
        join(__dirname, `../../docs/${randompdfFile}.${extension}`),
        buffer,
      );

      createComposantInput.pdf = `${randompdfFile}.${extension}`;
    } else {
      // If the PDF is not valid, set it to null
      createComposantInput.pdf = null;
    }

    // Generate a unique ID for the composant
    const index = await this.generateComposantId();
    createComposantInput._id = `Cmp${index}`;

    // Save the new composant
    return await new this.ComposantModel(createComposantInput)
      .save()
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeComposant(_id: string): Promise<Composant> {
    return this.ComposantModel.findOneAndUpdate(
      { _id },
      { $set: { isDeleted: true } },
      { new: true },
    );
  }

  async findAllComposants(): Promise<[Composant]> {
    return await this.ComposantModel.find({ isDeleted: false })
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async findOneComposant(name: string): Promise<Composant> {
    return await this.ComposantModel.findOne({ name }).exec();

    //   if (!Composant) {
    //     throw new Error(`Composant with ID '${_id}' not found.`);
    //   }
    //   return Composant;
    // } catch (error) {
    //   throw error;
    // }
  }

  // this function after recieving ticket from tech
  async addComposantInfo(
    updateComposant: CreateComposantInput,
  ): Promise<UpdateComposantResponse> {
    try {
      // Check if the PDF is a valid base64 string
      if (
        updateComposant.pdf &&
        updateComposant.pdf !== 'null' &&
        updateComposant.pdf.includes(',')
      ) {
        const extension = getFileExtension(updateComposant.pdf);
        const buffer = Buffer.from(
          updateComposant.pdf.split(',')[1], // Split base64 string to get the data
          'base64',
        );

        const randompdfFile = randomstring.generate({
          length: 12,
          charset: 'alphabetic',
        });

        fs.writeFileSync(
          join(__dirname, `../../docs/${randompdfFile}.${extension}`),
          buffer,
        );

        updateComposant.pdf = `${randompdfFile}.${extension}`;
      } else {
        // If the PDF is not valid, set it to null
        updateComposant.pdf = null;
      }
      // Perform the update operation
      const update = await this.ComposantModel.findOneAndUpdate(
        { name: updateComposant.name },
        {
          $set: {
            package: updateComposant.package,
            prix_achat: updateComposant.prix_achat,
            prix_vente: updateComposant.prix_vente,
            coming_date: updateComposant.coming_date,
            link: updateComposant.link,
            quantity_stocked: updateComposant.quantity_stocked,
            pdf: updateComposant.pdf,
            status: updateComposant.status_composant,
            category_composant_id: updateComposant.category_composant_id,
          },
        },
        { new: true },
      );
      console.log('update', update);
      return update;
    } catch (error) {
      throw new Error('Failed to update composant: ' + error.message);
    }
  }
}

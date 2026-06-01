import { Injectable } from '@nestjs/common';
import {
  CreateComposantInput,
  UpdateComposantResponse,
} from './dto/create-composant.input';
import { UpdateComposantInput } from './dto/update-composant.input';
import { InjectModel } from '@nestjs/mongoose';
import { Composant } from './entities/composant.entity';
import { Model } from 'mongoose';
import { join } from 'path';
import * as fs from 'fs';
import * as randomstring from 'randomstring';
import { getFileExtension } from 'src/di/shared.files';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';
@Injectable()
export class ComposantService {
  constructor(
    @InjectModel('Composant') private ComposantModel: Model<Composant>,
    private readonly operationalErrorService: OperationalErrorService,
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
    try {
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

      // Save the new composant — the silent .catch returning err was a
      // HIGH-severity bug (resolver returned an Error object that the FE
      // rendered as a row). Direct await now; failure routes through capture
      // and the original error rethrows so callers see the real cause.
      return await new this.ComposantModel(createComposantInput).save();
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'composant',
        submodule: 'composantService',
        method: 'CREATE_COMPOSANT',
        severity: 'HIGH',
        error: 'Failed to create Composant',
        message: (error as Error)?.message ?? String(error),
        payload: {
          name: createComposantInput?.name,
          package: createComposantInput?.package,
          categoryId: createComposantInput?.category_composant_id,
        },
      });
      throw error;
    }
  }

  async removeComposant(_id: string): Promise<Composant> {
    return await this.ComposantModel.findOneAndUpdate(
      { _id },
      { $set: { isDeleted: true } },
      { new: true },
    );
  }

  async findAllComposants(): Promise<[Composant]> {
    try {
      return (await this.ComposantModel.find({ isDeleted: false })) as [
        Composant,
      ];
    } catch (err) {
      // Previously a silent `.catch((err) => return err)` — the resolver
      // received an Error object that the FE rendered as a row. Now we
      // capture and return an empty list so the UI shows "no composants"
      // instead of an exploded row.
      await this.operationalErrorService.capture({
        module: 'composant',
        submodule: 'composantService',
        method: 'FIND_ALL_COMPOSANTS',
        severity: 'HIGH',
        error: 'Query failed (was previously swallowed)',
        message: (err as Error)?.message ?? String(err),
      });
      return [] as unknown as [Composant];
    }
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
  async updateComposant(updateComposant: CreateComposantInput) {
    const update = await this.ComposantModel.findByIdAndUpdate(
      updateComposant._id,
      {
        $set: {
          package: updateComposant.package,
          prix_achat: updateComposant.prix_achat,
          prix_vente: updateComposant.prix_vente,
          coming_date: updateComposant.coming_date,
          link: updateComposant.link,
          quantity_stocked: updateComposant.quantity_stocked,
          pdf: updateComposant.pdf,
          status_composant: updateComposant.status_composant,
          category_composant_id: updateComposant.category_composant_id,
        },
      },
      { new: true },
    );
    return update;
  }

  /**
   * Partial update: persist only the fields explicitly supplied in the
   * input. Used by reassignment flows (changing the category from the
   * Relations & Structure modal) so the caller doesn't have to resend
   * name/package/price/etc. just to change one field.
   */
  async updateComposantPartial(input: UpdateComposantInput) {
    const { _id, ...rest } = input;
    const updateSet: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) {
        updateSet[key] = value;
      }
    }
    return await this.ComposantModel.findByIdAndUpdate(
      _id,
      { $set: updateSet },
      { new: true },
    );
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
            status_composant: updateComposant.status_composant,
            category_composant_id: updateComposant.category_composant_id,
          },
        },
        { new: true },
      );

      return update;
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'composant',
        submodule: 'composantService',
        method: 'ADD_COMPOSANT_INFO',
        severity: 'MEDIUM',
        error: 'Failed to update composant',
        message: (error as Error)?.message ?? String(error),
        payload: { name: updateComposant?.name },
      });
      // Re-throw ORIGINAL error so callers see the real Mongo/FS cause
      // instead of the historical generic wrap.
      throw error;
    }
  }
  async searchComposants(name: string): Promise<any[]> {
    if (!name || name.trim().length < 2) {
      return [];
    }

    return this.ComposantModel.find({
      name: { $regex: name, $options: 'i' },
      isDeleted: false,
    })
      .select('_id name')
      .limit(20);
  }
}

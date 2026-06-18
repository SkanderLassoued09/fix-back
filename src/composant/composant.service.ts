import { Injectable } from '@nestjs/common';
import {
  CreateComposantInput,
  UpdateComposantResponse,
} from './dto/create-composant.input';
import { UpdateComposantInput } from './dto/update-composant.input';
import { InjectModel } from '@nestjs/mongoose';
import { Composant } from './entities/composant.entity';
import { Model } from 'mongoose';
import { getFileExtension } from 'src/di/shared.files';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';
import { GraphQLError } from 'graphql';
import { GoogleDriveService } from 'src/google-drive/google-drive.service';
@Injectable()
export class ComposantService {
  constructor(
    @InjectModel('Composant') private ComposantModel: Model<Composant>,
    // Used only to cascade a composant rename onto the DI linkage
    // (`array_composants[].nameComposant`), which references parts by name.
    @InjectModel('Di') private diModel: Model<any>,
    private readonly operationalErrorService: OperationalErrorService,
    private readonly googleDriveService: GoogleDriveService,
  ) {}

  /**
   * Upload a composant datasheet (fiche technique) to Drive — Drive-only, no
   * local docs/. Catalog parts aren't tied to a company/client, so they live in
   * a dedicated `composants` container, named
   * `{ComposantName}_FicheTechnique_{date}_{heure}.{ext}`. BEST-EFFORT: returns
   * null on failure (the catalog save is not blocked) and logs it.
   */
  private async uploadDatasheet(
    name: string,
    base64: string,
  ): Promise<string | null> {
    try {
      const ext = getFileExtension(base64);
      const buffer = Buffer.from(base64.split(',')[1], 'base64');
      const containerId =
        await this.googleDriveService.ensureNamedContainer('composants');
      const fileName = this.googleDriveService.buildDocFileName(
        name || 'Composant',
        'FicheTechnique',
        ext,
      );
      const mime = base64.split(',')[0]?.split(':')[1]?.split(';')[0];
      const uploaded = await this.googleDriveService.uploadFile(
        containerId,
        fileName,
        buffer,
        mime,
      );
      return uploaded.webViewLink;
    } catch (err) {
      await this.operationalErrorService.capture({
        module: 'composant',
        submodule: 'drive',
        method: 'UPLOAD_DATASHEET',
        severity: 'MEDIUM',
        error: 'Composant datasheet Drive upload failed',
        message: (err as Error)?.message ?? String(err),
        payload: { composantName: name },
      });
      return null;
    }
  }

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
        createComposantInput.pdf = await this.uploadDatasheet(
          createComposantInput.name,
          createComposantInput.pdf,
        );
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
      // Match by `_id` when the caller provides one (the magasin form does —
      // this is what lets the « Nom » edit persist: matching by the *new* name
      // would never find the row). Fall back to `name` for legacy callers that
      // don't send `_id`.
      const hasId =
        updateComposant._id &&
        updateComposant._id !== 'null' &&
        updateComposant._id !== 'undefined';
      const filter = hasId
        ? { _id: updateComposant._id }
        : { name: updateComposant.name };

      // Load the current row first — for the NOT_FOUND check and so we know the
      // OLD name (to cascade a rename onto the DI linkage below).
      const existing: any = await this.ComposantModel.findOne(filter).lean();
      if (!existing) {
        throw new GraphQLError(
          `Composant '${
            hasId ? updateComposant._id : updateComposant.name
          }' introuvable.`,
          { extensions: { code: 'NOT_FOUND' } },
        );
      }

      // PARTIAL update: only write fields the caller actually provided. An
      // absent / empty (null/undefined/"") field MUST keep its stored value —
      // never overwrite it (that erased Package/Prix/etc. on a name-only edit).
      // `0` and other real values ARE written.
      const set: Record<string, unknown> = {};
      const assign = (key: string, value: unknown) => {
        if (value === undefined || value === null || value === '') return;
        set[key] = value;
      };
      assign('name', updateComposant.name);
      assign('package', updateComposant.package);
      assign('prix_achat', updateComposant.prix_achat);
      assign('prix_vente', updateComposant.prix_vente);
      assign('coming_date', updateComposant.coming_date);
      assign('link', updateComposant.link);
      assign('quantity_stocked', updateComposant.quantity_stocked);
      assign('status_composant', updateComposant.status_composant);
      assign('category_composant_id', updateComposant.category_composant_id);

      // PDF: only touch it when a NEW file (base64 data URL) is supplied. When
      // the form re-sends the existing file name (or nothing), leave the stored
      // pdf untouched — re-nulling it on every save was wiping the datasheet.
      if (
        updateComposant.pdf &&
        updateComposant.pdf !== 'null' &&
        updateComposant.pdf.includes(',')
      ) {
        set.pdf = await this.uploadDatasheet(
          updateComposant.name,
          updateComposant.pdf,
        );
      }

      const update = await this.ComposantModel.findOneAndUpdate(
        filter,
        { $set: set },
        { new: true },
      );
      if (!update) {
        throw new GraphQLError(
          `Composant '${
            hasId ? updateComposant._id : updateComposant.name
          }' introuvable.`,
          { extensions: { code: 'NOT_FOUND' } },
        );
      }

      // Renaming the catalog part must follow its references: DIs link to a
      // composant BY NAME (`array_composants[].nameComposant`). Without this,
      // a rename orphaned the line — reopening the magasin modal looked up the
      // OLD name, found nothing, and showed every field empty / stock 0.
      const newName = set.name as string | undefined;
      if (newName && newName !== existing.name) {
        await this.diModel.updateMany(
          { 'array_composants.nameComposant': existing.name },
          { $set: { 'array_composants.$[elem].nameComposant': newName } },
          { arrayFilters: [{ 'elem.nameComposant': existing.name }] },
        );
      }

      return update;
    } catch (error) {
      // Expected errors (NOT_FOUND) are not operational — let them propagate
      // for the global filter to log (LOW, no Discord); only real failures
      // (Mongo/FS) are captured here.
      if (error instanceof GraphQLError) {
        throw error;
      }
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

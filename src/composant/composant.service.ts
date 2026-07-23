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
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
@Injectable()
export class ComposantService {
  constructor(
    @InjectModel('Composant') private ComposantModel: Model<Composant>,
    // Used only to cascade a composant rename onto the DI linkage
    // (`array_composants[].nameComposant`), which references parts by name.
    @InjectModel('Di') private diModel: Model<any>,
    // Used only to validate that a written `category_composant_id`
    // references an existing category (see assertCategoryExists).
    @InjectModel('Composant_Category') private categoryModel: Model<any>,
    private readonly operationalErrorService: OperationalErrorService,
    private readonly googleDriveService: GoogleDriveService,
    private readonly discordHookService: DiscordHookService,
  ) {}

  /**
   * Garde-fou anti-pollution : `category_composant_id` doit référencer une
   * catégorie EXISTANTE (non supprimée). Historiquement le front envoyait le
   * LIBELLÉ (« resistqmce ») et le back l'écrivait tel quel — un client
   * obsolète peut encore le faire. Absent/vide → pas de validation (champ
   * optionnel, la mise à jour partielle conserve la valeur stockée).
   * NB : les _id de catégorie sont des String custom `C_Composant<N>` (pas des
   * ObjectId) — le exists() ne fait donc aucun cast susceptible de jeter.
   */
  private async assertCategoryExists(
    categoryId: string | null | undefined,
  ): Promise<void> {
    if (!categoryId || categoryId === 'null' || categoryId === 'undefined') {
      return;
    }
    const exists = await this.categoryModel.exists({
      _id: categoryId,
      isDeleted: { $ne: true },
    });
    if (!exists) {
      throw new GraphQLError(
        `Catégorie '${categoryId}' introuvable — sélectionnez une catégorie valide.`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
  }

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
      // Structured per-composant folder under CLIENTS, mirroring client/company:
      // CLIENTS/composant/<Name>_<date>/ — idempotent by name (reused per part).
      const entityFolder = await this.googleDriveService.ensureEntityFolder(
        'composant',
        name || 'Composant',
      );
      const containerId = entityFolder.id;
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
    // Author from the JWT (forwarded by the resolver via `@CurrentUser`).
    // Optional — preserved as `any` because not every test fixture seeds a
    // full Profile; the Discord embed handles "Auteur inconnu" gracefully.
    profile?: any,
  ): Promise<Composant> {
    try {
      // Reject a non-existent category BEFORE any side effect (Drive upload).
      await this.assertCategoryExists(
        createComposantInput.category_composant_id,
      );

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
      const saved = await new this.ComposantModel(createComposantInput).save();

      // Catalog event — fire-and-forget Discord notification so procurement
      // sees new parts (price, package, stock). Failure must NOT block the
      // save: route through captureDiscordFailure via the same pattern as
      // every other Discord side-effect site.
      try {
        await this.discordHookService.sendComposantCreated({
          composant: saved,
          profile,
        });
      } catch (notifErr) {
        await this.operationalErrorService.capture({
          module: 'composant',
          submodule: 'discord',
          method: 'SEND_COMPOSANT_CREATED',
          severity: 'LOW',
          error: 'Discord notification failed',
          message: (notifErr as Error)?.message ?? String(notifErr),
          payload: { name: saved?.name, _id: saved?._id },
        });
      }

      return saved;
    } catch (error) {
      // Expected errors (validation catégorie → BAD_USER_INPUT) ne sont pas
      // opérationnelles — même pattern que addComposantInfo.
      if (error instanceof GraphQLError) {
        throw error;
      }
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
      const composants = await this.ComposantModel.find({
        isDeleted: false,
      }).sort({ createdAt: -1 });
      // Le type de retour déclaré est un tuple `[Composant]` (approximation
      // historique de `Composant[]`) → cast via unknown, comme avant le tri.
      return composants as unknown as [Composant];
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
    // Aligné sur findAllComposants : un composant soft-supprimé ne doit pas
    // rester chargeable/modifiable via le modal (il « ressuscitait » sinon).
    // `$ne: true` et non `false` : les documents hérités SANS champ isDeleted
    // doivent rester trouvables ({isDeleted: false} ne matche pas un champ
    // absent en Mongo).
    const composant = await this.ComposantModel.findOne({
      name,
      isDeleted: { $ne: true },
    }).exec();
    if (!composant) {
      // Clean NOT_FOUND instead of returning null into the non-nullable
      // `Query.findOneComposant` field (which surfaced as an unreadable
      // "Cannot return null for non-nullable field" internal error).
      throw new GraphQLError(`Composant '${name}' introuvable.`, {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    return composant;
  }
  async updateComposant(updateComposant: CreateComposantInput) {
    await this.assertCategoryExists(updateComposant.category_composant_id);
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
    if ('category_composant_id' in updateSet) {
      await this.assertCategoryExists(
        updateSet.category_composant_id as string,
      );
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

      // Une catégorie fournie doit exister — un client obsolète qui envoie
      // encore le LIBELLÉ est rejeté proprement au lieu de polluer la base.
      if ('category_composant_id' in set) {
        await this.assertCategoryExists(set.category_composant_id as string);
      }

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

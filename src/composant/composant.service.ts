import { Injectable } from '@nestjs/common';
import {
  CreateComposantInput,
  UpdateComposantResponse,
} from './dto/create-composant.input';
import { UpdateComposantInput } from './dto/update-composant.input';
import { ComposantBrowseInput } from './dto/browse-composant.input';
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

  /**
   * Prochain index libre = MAXIMUM NUMÉRIQUE réel des `_id` `Cmp<N>` + 1.
   *
   * L'ancienne version prenait « le dernier créé » (tri `createdAt`) comme plus
   * grand index — même défaut que celui corrigé dans
   * `Composant_CategoryService.generateComposant_CategoryId` : après une
   * insertion en masse (migration 016), plusieurs documents partagent la même
   * milliseconde, Mongo départage par ordre naturel et l'index calculé est déjà
   * pris → E11000 à la création. On balaye TOUS les `_id` au format, supprimés
   * compris (suppression douce : un id reste occupé).
   */
  async generateComposantId(): Promise<number> {
    const prefix = 'Cmp';
    const rows = await this.ComposantModel.find(
      { _id: { $regex: `^${prefix}\\d+$` } },
      { _id: 1 },
    ).lean();

    let maxIndex = -1;
    for (const row of rows) {
      const parsed = Number(String(row._id).slice(prefix.length));
      if (Number.isFinite(parsed) && parsed > maxIndex) {
        maxIndex = parsed;
      }
    }
    return maxIndex + 1;
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
      assign('code_article', updateComposant.code_article);
      assign('emplacement', updateComposant.emplacement);
      assign('stock_min', updateComposant.stock_min);

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
  /**
   * Échappe les métacaractères regex d'une saisie utilisateur.
   *
   * POURQUOI : `searchComposants` (plus bas, historique) injecte la saisie
   * BRUTE dans `$regex`. Un `(` tapé par l'utilisateur lève une erreur Mongo,
   * et `.*` force un balayage complet. Tout nouveau chemin de recherche passe
   * par ici. Même expression que `composant_category.service.ts`.
   */
  private static escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Sentinelle du bucket « Sans catégorie » (voir composantCategoryTree). */
  static readonly UNCATEGORIZED_ID = '__uncategorized__';

  /** En dessous, une recherche ramènerait la moitié du catalogue. */
  private static readonly MIN_SEARCH_LENGTH = 2;

  /** Normalise un libellé pour la comparaison (casse + espaces). */
  private static normalizeLabel(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toLowerCase();
  }

  /**
   * Une valeur de `category_composant_id` est-elle « vide » ?
   * `'undefined'` / `'null'` sont des chaînes LITTÉRALES réellement présentes
   * en base (écrites par l'ancien `updateComposant`), pas les types.
   */
  private static isBlankCategoryRef(value: unknown): boolean {
    const raw = String(value ?? '').trim();
    return raw === '' || raw === 'undefined' || raw === 'null';
  }

  /**
   * Construit le filtre Mongo du picker.
   *
   * Le point délicat est `category_composant_id` : des lignes héritées y
   * stockent le LIBELLÉ de la catégorie au lieu de son `_id` (cf. migration
   * 002). Une catégorie doit donc matcher `{ $in: [_id, libellé] }`, sinon ses
   * composants hérités sont invisibles dans l'arbre.
   */
  private async buildBrowseFilter(
    input: ComposantBrowseInput,
  ): Promise<Record<string, any>> {
    // `$ne: true` et non `false` : aligné sur findOneComposant — un document
    // hérité SANS le champ `isDeleted` ne doit pas disparaître du picker.
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    const search = (input?.search ?? '').trim();
    if (search.length >= ComposantService.MIN_SEARCH_LENGTH) {
      filter.name = {
        $regex: ComposantService.escapeRegex(search),
        $options: 'i',
      };
    }

    const categoryId = (input?.categoryId ?? '').trim();
    if (!categoryId) {
      return filter;
    }

    const categories = await this.categoryModel
      .find({ isDeleted: { $ne: true } })
      .select('_id category_composant')
      .lean();

    if (categoryId === ComposantService.UNCATEGORIZED_ID) {
      // Tout ce qui ne pointe AUCUNE catégorie connue — ni par _id, ni par
      // libellé. `$nin` matche aussi les documents où le champ est ABSENT,
      // ce qui est exactement le comportement voulu.
      const known = categories.flatMap((c: any) => [
        String(c._id),
        String(c.category_composant ?? ''),
      ]);
      filter.category_composant_id = {
        $nin: [...new Set([...known, '', 'undefined', 'null'])],
      };
      return filter;
    }

    const match = categories.find(
      (c: any) => String(c._id) === categoryId,
    ) as any;
    const label = match?.category_composant
      ? String(match.category_composant)
      : null;
    filter.category_composant_id = label
      ? { $in: [categoryId, label] }
      : categoryId;
    return filter;
  }

  /**
   * Page de composants pour l'arbre du modal diagnostic.
   *
   * Projection VOLONTAIREMENT minimale (`_id name category_composant_id`) :
   * `findAllComposant` rapatriait 11 champs — dont `pdf` et `link` — pour un
   * picker qui n'affiche qu'un nom.
   *
   * Tri alphabétique : `createdAt: -1` (tri du catalogue) n'a aucun sens dans
   * une liste où l'utilisateur cherche un nom.
   */
  async browseComposants(
    input: ComposantBrowseInput,
  ): Promise<{ composantRecord: Composant[]; totalComposantCount: number }> {
    try {
      const rows = Math.min(Math.max(Number(input?.rows ?? 50) || 50, 1), 200);
      const first = Math.max(Number(input?.first ?? 0) || 0, 0);
      const filter = await this.buildBrowseFilter(input ?? {});

      const [composantRecord, totalComposantCount] = await Promise.all([
        this.ComposantModel.find(filter)
          .select('_id name category_composant_id')
          .sort({ name: 1 })
          .skip(first)
          .limit(rows)
          .lean(),
        this.ComposantModel.countDocuments(filter),
      ]);

      return {
        composantRecord: composantRecord as unknown as Composant[],
        totalComposantCount,
      };
    } catch (err) {
      await this.operationalErrorService.capture({
        module: 'composant',
        submodule: 'composantService',
        method: 'BROWSE_COMPOSANTS',
        severity: 'MEDIUM',
        error: 'Browse query failed',
        message: (err as Error)?.message ?? String(err),
        payload: {
          categoryId: input?.categoryId,
          hasSearch: !!input?.search,
        },
      });
      // Page vide plutôt qu'une erreur GraphQL : le picker reste utilisable
      // (la recherche plein-texte continue de fonctionner).
      return { composantRecord: [], totalComposantCount: 0 };
    }
  }

  /**
   * Racines de l'arbre : les catégories + leur nombre de composants.
   *
   * DEUX requêtes, pas de N+1 : un `$group` sur les composants, puis
   * réconciliation en mémoire avec la liste des catégories.
   *
   * Toute clé de regroupement qui ne correspond à aucune catégorie est
   * d'abord retentée PAR LIBELLÉ (rattrape la pollution héritée), et sinon
   * versée dans un nœud synthétique « Sans catégorie ». Sans ce repli, les
   * composants concernés deviendraient INATTEIGNABLES dans l'arbre — une
   * régression face au dropdown plat qui, lui, les listait tous.
   */
  async composantCategoryTree(): Promise<
    Array<{ _id: string; category_composant: string; composantCount: number }>
  > {
    try {
      const [categories, grouped] = await Promise.all([
        this.categoryModel
          .find({ isDeleted: { $ne: true } })
          .select('_id category_composant')
          .lean(),
        this.ComposantModel.aggregate([
          { $match: { isDeleted: { $ne: true } } },
          { $group: { _id: '$category_composant_id', count: { $sum: 1 } } },
        ]),
      ]);

      const byId = new Map<string, any>(
        categories.map((c: any) => [String(c._id), c]),
      );
      const byLabel = new Map<string, any>(
        categories.map((c: any) => [
          ComposantService.normalizeLabel(c.category_composant),
          c,
        ]),
      );

      const counts = new Map<string, number>();
      let uncategorized = 0;

      for (const row of grouped as Array<{ _id: unknown; count: number }>) {
        const count = Number(row?.count ?? 0);
        if (count <= 0) continue;

        let match: any = null;
        if (!ComposantService.isBlankCategoryRef(row?._id)) {
          const key = String(row._id).trim();
          match =
            byId.get(key) ??
            byLabel.get(ComposantService.normalizeLabel(key)) ??
            null;
        }

        if (match) {
          const id = String(match._id);
          counts.set(id, (counts.get(id) ?? 0) + count);
        } else {
          uncategorized += count;
        }
      }

      const nodes = categories
        .map((c: any) => ({
          _id: String(c._id),
          category_composant: String(c.category_composant ?? ''),
          composantCount: counts.get(String(c._id)) ?? 0,
        }))
        .sort((a, b) =>
          a.category_composant.localeCompare(b.category_composant, 'fr', {
            sensitivity: 'base',
          }),
        );

      if (uncategorized > 0) {
        // Toujours en dernier : c'est un fourre-tout, pas une vraie catégorie.
        nodes.push({
          _id: ComposantService.UNCATEGORIZED_ID,
          category_composant: 'Sans catégorie',
          composantCount: uncategorized,
        });
      }

      return nodes;
    } catch (err) {
      await this.operationalErrorService.capture({
        module: 'composant',
        submodule: 'composantService',
        method: 'COMPOSANT_CATEGORY_TREE',
        severity: 'MEDIUM',
        error: 'Category tree query failed',
        message: (err as Error)?.message ?? String(err),
      });
      return [];
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

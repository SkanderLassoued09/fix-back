import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Composant_Category } from './entities/composant_category.entity';
import { CreateComposant_CategoryInput } from './dto/create-composant_category.input';

@Injectable()
export class Composant_CategoryService implements OnModuleInit {
  private readonly logger = new Logger(Composant_CategoryService.name);

  /** Catégories de composant de BASE. Seedées **uniquement sur une base vide**
   *  (idempotent) pour qu'un poste/une base fraîche n'ait jamais un dropdown
   *  vide. Éditable : sur une base déjà peuplée, AUCUN ajout n'est fait. */
  private static readonly BASE_CATEGORIES = [
    'Résistance',
    'Condensateur',
    'Transistor',
    'Diode',
    'Circuit intégré',
    'Connecteur',
    'Relais',
    'Fusible',
  ];

  constructor(
    @InjectModel('Composant_Category')
    private Composant_CategoryModel: Model<Composant_Category>,
  ) {}

  /** Préfixe des `_id` maison : `C_Composant<N>`. Sa longueur sert à extraire
   *  la partie numérique — ne pas la recalculer à la main (l'ancien code codait
   *  `substring(11)` en dur). */
  private static readonly ID_PREFIX = 'C_Composant';

  /** Seed idempotent des catégories de base au démarrage : ne fait rien si la
   *  collection contient déjà des catégories (base configurée). */
  async onModuleInit(): Promise<void> {
    try {
      const count = await this.Composant_CategoryModel.estimatedDocumentCount();
      if (count > 0) return; // base déjà peuplée → ne rien seeder
      for (const label of Composant_CategoryService.BASE_CATEGORIES) {
        // Un try/catch PAR libellé : `createComposant_Category` lève désormais
        // sur doublon (avant, il renvoyait silencieusement l'existant). Sans
        // cette isolation, un seul conflit interromprait le reste du seed.
        try {
          await this.createComposant_Category({
            category_composant: label,
          } as CreateComposant_CategoryInput);
        } catch (err) {
          this.logger.warn(
            `Seed : catégorie « ${label} » ignorée (${
              (err as Error)?.message ?? err
            }).`,
          );
        }
      }
      this.logger.log(
        `Seed : ${Composant_CategoryService.BASE_CATEGORIES.length} catégories de composant de base traitées (base vide détectée).`,
      );
    } catch (err) {
      this.logger.warn(
        `Seed catégories ignoré : ${(err as Error)?.message ?? err}.`,
      );
    }
  }

  /**
   * Prochain index libre = MAXIMUM NUMÉRIQUE réel des `_id` existants + 1.
   *
   * L'implémentation précédente prenait « le dernier créé »
   * (`findOne({}, {}, { sort: { createdAt: -1 } })`) comme approximation du plus
   * grand index. Ce n'en est pas une :
   *   - 16 des 19 documents en base partagent la MÊME milliseconde `createdAt`
   *     (insertion en masse par un script de seed). Le tri est donc à égalité et
   *     Mongo départage par ordre naturel → il renvoyait `C_Composant3` alors
   *     que le maximum réel est 18, d'où un `_id` déjà pris et un `E11000` à
   *     chaque création ;
   *   - même avec des dates distinctes, « le plus récent » ≠ « le plus grand »
   *     dès qu'une insertion se fait dans le désordre ;
   *   - `+'...'.substring(11)` sur un `_id` hors format donnait `NaN`, donc
   *     `C_ComposantNaN`, qui se relisait en `NaN` : collision définitive.
   *
   * On balaye TOUS les documents, y compris `isDeleted: true` : la suppression
   * est douce, un id supprimé reste occupé et ne doit jamais être réattribué.
   */
  async generateComposant_CategoryId(): Promise<number> {
    const prefix = Composant_CategoryService.ID_PREFIX;
    const rows = await this.Composant_CategoryModel.find(
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
    // Collection vide (ou aucun id au format) → on repart de 0.
    return maxIndex + 1;
  }

  async createComposant_Category(
    createComposant_CategoryInput: CreateComposant_CategoryInput,
  ): Promise<Composant_Category> {
    const normalizedCategory =
      createComposant_CategoryInput.category_composant?.trim();
    if (!normalizedCategory) {
      throw new Error('Composant category name is required');
    }
    const escapedCategory = normalizedCategory.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    const existing = await this.Composant_CategoryModel.findOne({
      category_composant: { $regex: `^${escapedCategory}$`, $options: 'i' },
      isDeleted: false,
    });

    // Doublon de nom : on LÈVE au lieu de renvoyer silencieusement l'existant.
    // Avant, l'appelant recevait une catégorie et affichait « Catégorie créée »
    // alors que rien n'avait été créé.
    if (existing) {
      throw new ConflictException('Cette catégorie existe déjà.');
    }

    createComposant_CategoryInput.category_composant = normalizedCategory;

    // `generateComposant_CategoryId` (lecture) puis `save` (écriture) n'est pas
    // atomique : deux créations simultanées calculent le même index. On retente
    // sur E11000 en recalculant l'index — borné pour ne jamais boucler.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const index = await this.generateComposant_CategoryId();
      createComposant_CategoryInput._id = `${Composant_CategoryService.ID_PREFIX}${index}`;
      try {
        // `await` direct : le `.catch((err) => err)` d'origine renvoyait
        // l'objet Error COMME s'il s'agissait de la catégorie. Tous les champs
        // de l'ObjectType étant nullable, GraphQL le sérialisait en
        // `{_id: null, category_composant: null}` SANS tableau `errors` — le
        // front ne pouvait pas voir l'échec. Même correctif que celui déjà
        // appliqué au module frère `composant.service.ts`.
        return await new this.Composant_CategoryModel(
          createComposant_CategoryInput,
        ).save();
      } catch (err) {
        const isDuplicate = (err as { code?: number })?.code === 11000;
        if (!isDuplicate || attempt === MAX_ATTEMPTS) {
          throw err;
        }
        this.logger.warn(
          `Collision d'_id sur « ${createComposant_CategoryInput._id} » (essai ${attempt}/${MAX_ATTEMPTS}) — nouvel index recalculé.`,
        );
      }
    }
    // Inatteignable : la boucle sort par `return` ou par `throw`.
    throw new ConflictException(
      "Impossible d'attribuer un identifiant de catégorie.",
    );
  }

  async removeComposant_Category(_id: string): Promise<Composant_Category> {
    const data = await this.Composant_CategoryModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          isDeleted: true,
        },
      },
      { new: true },
    );
    return data;
  }

  async findAllComposant_Categorys(): Promise<Composant_Category[]> {
    // Même correctif que `createComposant_Category` : le `.catch((err) => err)`
    // renvoyait un objet Error là où un tableau est attendu.
    return await this.Composant_CategoryModel.find({ isDeleted: false }).sort({
      createdAt: -1,
    });
  }

  async findOneComposant_Category(_id: string): Promise<Composant_Category> {
    try {
      const Composant_Category = await this.Composant_CategoryModel.findById(
        _id,
      ).lean();

      if (!Composant_Category) {
        throw new Error(`Composant_Category with ID '${_id}' not found.`);
      }
      return Composant_Category;
    } catch (error) {
      throw error;
    }
  }
}

import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';
import { ComposantService } from './composant.service';
import { GoogleDriveService } from 'src/google-drive/google-drive.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';

/**
 * Unit tests du picker de composants (arbre du modal diagnostic).
 *
 * Gardes :
 *  - `browseComposants` filtre par catégorie EN ACCEPTANT le libellé hérité
 *    (des lignes stockent le libellé au lieu de l'_id — cf. migration 002) ;
 *  - la saisie de recherche est ÉCHAPPÉE avant d'entrer dans `$regex` ;
 *  - `isDeleted` se teste en `$ne: true` (les documents hérités sans le champ
 *    doivent rester visibles) ;
 *  - `composantCategoryTree` rattrape les catégories polluées PAR LIBELLÉ et
 *    verse le reste dans « Sans catégorie » — sans quoi ces composants seraient
 *    INATTEIGNABLES dans l'arbre.
 */

/** Chaîne `find().select().sort().skip().limit().lean()`. */
const findChain = (rows: unknown[]) => {
  const chain: any = {};
  chain.select = jest.fn(() => chain);
  chain.sort = jest.fn(() => chain);
  chain.skip = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve(rows));
  return chain;
};

/** Chaîne `find().select().lean()` du modèle catégorie. */
const categoryChain = (rows: unknown[]) => {
  const chain: any = {};
  chain.select = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve(rows));
  return chain;
};

const CATEGORIES = [
  { _id: 'C_Composant1', category_composant: 'Résistance' },
  { _id: 'C_Composant2', category_composant: 'Condensateur' },
];

describe('ComposantService — picker (browse + category tree)', () => {
  let service: ComposantService;
  let model: any;
  let category: any;
  let capture: jest.Mock;

  beforeEach(async () => {
    model = {
      find: jest.fn(),
      countDocuments: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue([]),
    };
    category = { find: jest.fn(() => categoryChain(CATEGORIES)), exists: jest.fn() };
    capture = jest.fn();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ComposantService,
        { provide: getModelToken('Composant'), useValue: model },
        { provide: getModelToken('Di'), useValue: { updateMany: jest.fn() } },
        { provide: getModelToken('Composant_Category'), useValue: category },
        { provide: OperationalErrorService, useValue: { capture } },
        {
          provide: GoogleDriveService,
          useValue: {
            ensureNamedContainer: jest.fn(),
            buildDocFileName: jest.fn(),
            uploadFile: jest.fn(),
          },
        },
        {
          provide: DiscordHookService,
          useValue: { sendComposantCreated: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(ComposantService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('browseComposants', () => {
    it('n exclut que les composants explicitement supprimés ($ne: true)', async () => {
      model.find.mockReturnValue(findChain([]));
      await service.browseComposants({} as any);

      const [filter] = model.find.mock.calls[0];
      // `isDeleted: false` ne matcherait PAS un document hérité sans le champ.
      expect(filter.isDeleted).toEqual({ $ne: true });
    });

    it('accepte l _id ET le libellé hérité pour une catégorie', async () => {
      model.find.mockReturnValue(findChain([]));
      await service.browseComposants({ categoryId: 'C_Composant1' } as any);

      const [filter] = model.find.mock.calls[0];
      expect(filter.category_composant_id).toEqual({
        $in: ['C_Composant1', 'Résistance'],
      });
    });

    it('« Sans catégorie » = tout ce qui ne pointe aucune catégorie connue', async () => {
      model.find.mockReturnValue(findChain([]));
      await service.browseComposants({
        categoryId: ComposantService.UNCATEGORIZED_ID,
      } as any);

      const [filter] = model.find.mock.calls[0];
      const excluded = filter.category_composant_id.$nin;
      expect(excluded).toEqual(expect.arrayContaining(['C_Composant1', 'Résistance']));
      // Les sentinelles littérales réellement présentes en base.
      expect(excluded).toEqual(expect.arrayContaining(['', 'undefined', 'null']));
    });

    it('ÉCHAPPE la saisie avant de la passer à $regex', async () => {
      model.find.mockReturnValue(findChain([]));
      // Une parenthèse non échappée fait lever Mongo ("unmatched parenthesis").
      await service.browseComposants({ search: 'res(50' } as any);

      const [filter] = model.find.mock.calls[0];
      expect(filter.name.$regex).toBe('res\\(50');
      expect(filter.name.$options).toBe('i');
    });

    it('ignore une recherche de moins de 2 caractères', async () => {
      model.find.mockReturnValue(findChain([]));
      await service.browseComposants({ search: 'r' } as any);

      const [filter] = model.find.mock.calls[0];
      expect(filter.name).toBeUndefined();
    });

    it('projette le strict minimum, trie par nom et pagine', async () => {
      const chain = findChain([{ _id: 'X', name: 'abc' }]);
      model.find.mockReturnValue(chain);
      model.countDocuments.mockResolvedValue(7);

      const res = await service.browseComposants({ rows: 20, first: 40 } as any);

      expect(chain.select).toHaveBeenCalledWith('_id name category_composant_id');
      expect(chain.sort).toHaveBeenCalledWith({ name: 1 });
      expect(chain.skip).toHaveBeenCalledWith(40);
      expect(chain.limit).toHaveBeenCalledWith(20);
      expect(res.totalComposantCount).toBe(7);
      expect(res.composantRecord).toHaveLength(1);
    });

    it('borne la taille de page (garde anti-dump)', async () => {
      const chain = findChain([]);
      model.find.mockReturnValue(chain);
      await service.browseComposants({ rows: 99999 } as any);
      expect(chain.limit).toHaveBeenCalledWith(200);
    });

    it('renvoie une page vide au lieu de jeter quand Mongo échoue', async () => {
      model.find.mockImplementation(() => {
        throw new Error('mongo down');
      });

      const res = await service.browseComposants({} as any);

      expect(res).toEqual({ composantRecord: [], totalComposantCount: 0 });
      expect(capture).toHaveBeenCalled();
    });
  });

  describe('composantCategoryTree', () => {
    it('compte par catégorie et marque les catégories vides', async () => {
      model.aggregate.mockResolvedValue([
        { _id: 'C_Composant1', count: 3 },
      ]);

      const tree = await service.composantCategoryTree();

      const resistance = tree.find((n) => n._id === 'C_Composant1');
      const condensateur = tree.find((n) => n._id === 'C_Composant2');
      expect(resistance?.composantCount).toBe(3);
      expect(condensateur?.composantCount).toBe(0);
    });

    it('rattrape PAR LIBELLÉ une catégorie polluée et la fusionne', async () => {
      // Pollution héritée : la ligne porte « Résistance » au lieu de l'_id.
      model.aggregate.mockResolvedValue([
        { _id: 'C_Composant1', count: 2 },
        { _id: 'résistance', count: 4 },
      ]);

      const tree = await service.composantCategoryTree();

      expect(tree.find((n) => n._id === 'C_Composant1')?.composantCount).toBe(6);
      expect(
        tree.find((n) => n._id === ComposantService.UNCATEGORIZED_ID),
      ).toBeUndefined();
    });

    it('verse dans « Sans catégorie » ce qui ne correspond à rien', async () => {
      model.aggregate.mockResolvedValue([
        { _id: null, count: 2 },
        { _id: 'undefined', count: 1 },
        { _id: 'categorie-fantome', count: 5 },
      ]);

      const tree = await service.composantCategoryTree();
      const bucket = tree.find(
        (n) => n._id === ComposantService.UNCATEGORIZED_ID,
      );

      expect(bucket?.composantCount).toBe(8);
      expect(bucket?.category_composant).toBe('Sans catégorie');
      // Toujours en dernier : c'est un fourre-tout, pas une vraie catégorie.
      expect(tree[tree.length - 1]._id).toBe(ComposantService.UNCATEGORIZED_ID);
    });

    it('n ajoute PAS le bucket quand tout est correctement catégorisé', async () => {
      model.aggregate.mockResolvedValue([{ _id: 'C_Composant2', count: 1 }]);

      const tree = await service.composantCategoryTree();

      expect(tree).toHaveLength(CATEGORIES.length);
    });

    it('trie les catégories alphabétiquement', async () => {
      const tree = await service.composantCategoryTree();
      expect(tree.map((n) => n.category_composant)).toEqual([
        'Condensateur',
        'Résistance',
      ]);
    });
  });
});

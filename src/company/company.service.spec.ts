import * as mongoose from 'mongoose';
import { CompanysService } from './company.service';
import { CompanySchema } from './entities/company.entity';

/**
 * Société — persistance du téléphone + recherche par téléphone.
 *
 * Utilise un VRAI modèle Mongoose construit depuis `CompanySchema` (le cast du
 * schéma s'applique donc réellement : un champ absent du schéma serait
 * silencieusement supprimé du document), avec `save()` stubbé pour ne pas
 * nécessiter de connexion DB.
 */
describe('CompanysService — téléphone de la société', () => {
  let model: mongoose.Model<any>;
  let service: CompanysService;

  beforeAll(() => {
    model =
      (mongoose.models.CompanySpec as mongoose.Model<any>) ||
      mongoose.model('CompanySpec', CompanySchema);
  });

  beforeEach(() => {
    jest
      .spyOn(model.prototype as any, 'save')
      .mockImplementation(function (this: any) {
        return Promise.resolve(this);
      });
    // Pas de doublon → assertNoDuplicate passe.
    jest
      .spyOn(model as any, 'findOne')
      .mockReturnValue({ lean: () => Promise.resolve(null) } as any);
    service = new CompanysService(model as any, {} as any, {} as any);
    // Drive est best-effort et hors sujet ici.
    (service as any).attachDriveFolder = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('createcompany', () => {
    it('persiste le téléphone fourni (le champ traverse input → document)', async () => {
      const out: any = await service.createcompany({
        name: 'ACME',
        raisonSociale: 'ACME SARL',
        phone: '+216 71 123 456',
        email: 'contact@acme.tn',
      } as any);

      expect(out.phone).toBe('+216 71 123 456');
      // Les autres champs ne sont pas cassés au passage.
      expect(out.raisonSociale).toBe('ACME SARL');
      expect(out.email).toBe('contact@acme.tn');
      expect(String(out._id)).toHaveLength(36); // uuid assigné par le service
    });

    it('accepte une création SANS téléphone (champ optionnel, aucune erreur)', async () => {
      const out: any = await service.createcompany({
        name: 'X',
        raisonSociale: 'X SARL',
      } as any);

      expect(out.raisonSociale).toBe('X SARL');
      expect(out.phone).toBeUndefined();
    });

    it('durcissement : neutralise les chaînes « undefined »/« null » (jamais persistées)', async () => {
      const out: any = await service.createcompany({
        name: 'OK CO',
        raisonSociale: 'OK CO',
        Exoneration: 'undefined',
        fax: 'null',
        webSiteLink: 'UNDEFINED',
        serviceAchat: { name: 'undefined', email: 'a@b.tn', phone: 'null' },
      } as any);

      expect(out.Exoneration).toBe('');
      expect(out.fax).toBe('');
      expect(out.webSiteLink).toBe('');
      expect(out.serviceAchat.name).toBe(''); // récursif sur les contacts
      expect(out.serviceAchat.email).toBe('a@b.tn'); // valeur réelle intacte
      expect(out.serviceAchat.phone).toBe('');
    });
  });

  describe('findAllCompanys — ordre par défaut « dernier créé en premier »', () => {
    function mockList(rows: any[] = []) {
      const chain: any = {
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(rows),
      };
      jest.spyOn(model as any, 'find').mockReturnValue(chain);
      jest
        .spyOn(model as any, 'countDocuments')
        .mockReturnValue({ exec: () => Promise.resolve(rows.length) } as any);
      return chain;
    }

    it('trie createdAt DESC (la liste n’avait AUCUN tri → ordre Mongo non garanti)', async () => {
      const chain = mockList([{ _id: 'S1' }]);
      await service.findAllCompanys({ first: 0, rows: 10 } as any);
      expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
    });

    it('le tri est appliqué AVANT skip/limit (page 1 = les plus récents)', async () => {
      const chain = mockList([]);
      await service.findAllCompanys({ first: 20, rows: 10 } as any);
      const order = ['sort', 'limit', 'skip'].map((m) =>
        (chain[m] as jest.Mock).mock.invocationCallOrder[0],
      );
      // sort AVANT limit/skip, sinon la pagination découpe un ordre arbitraire.
      expect(order[0]).toBeLessThan(order[1]);
      expect(chain.skip).toHaveBeenCalledWith(20);
      expect(chain.limit).toHaveBeenCalledWith(10);
    });

    it('se compose avec le filtre existant (soft-delete exclu)', async () => {
      mockList([]);
      await service.findAllCompanys({ first: 0, rows: 10 } as any);
      expect(model.find).toHaveBeenCalledWith({ isDeleted: { $ne: true } });
    });
  });

  describe('searchCompany — recherche par téléphone', () => {
    function mockQuery(rows: any[] = []) {
      const chain: any = {
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(rows),
      };
      jest.spyOn(model as any, 'find').mockReturnValue(chain);
      jest.spyOn(model as any, 'countDocuments').mockResolvedValue(rows.length);
      return chain;
    }

    it('construit bien un filtre sur `phone` (le case manquait → recherche sans effet)', async () => {
      mockQuery([]);
      await service.searchCompany(
        { first: 0, rows: 10 } as any,
        { field: 'phone', value: '71 123' },
      );
      expect(model.find).toHaveBeenCalledWith({
        phone: { $regex: '71 123', $options: 'i' },
      });
      expect(model.countDocuments).toHaveBeenCalledWith({
        phone: { $regex: '71 123', $options: 'i' },
      });
    });

    it('laisse les autres champs de recherche inchangés (non-régression)', async () => {
      mockQuery([]);
      await service.searchCompany(
        { first: 0, rows: 10 } as any,
        { field: 'fax', value: '71 999' },
      );
      expect(model.find).toHaveBeenCalledWith({
        fax: { $regex: '71 999', $options: 'i' },
      });
    });
  });
});

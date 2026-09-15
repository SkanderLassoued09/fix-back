import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';
import { GoogleDriveService } from 'src/google-drive/google-drive.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { ComposantService } from './composant.service';

/**
 * `createComposant` — un composant NEUF n'a aucun champ null ni absent : texte
 * `''`, nombres `0` (prix à 0 = « pas de prix »), sentinelles « null » /
 * « undefined » envoyées par certains écrans ramenées à `''`.
 */
describe('ComposantService.createComposant — champs initialisés', () => {
  let service: ComposantService;
  let saved: Record<string, any> | null;
  let category: { exists: jest.Mock };
  let upload: jest.SpyInstance;

  beforeEach(async () => {
    saved = null;
    // Le modèle est un CONSTRUCTEUR : on capture le document passé à `new`.
    const ModelMock: any = jest.fn().mockImplementation((doc: any) => ({
      save: jest.fn().mockImplementation(async () => {
        saved = doc;
        return doc;
      }),
    }));
    category = { exists: jest.fn().mockResolvedValue({ _id: 'C_Composant3' }) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ComposantService,
        { provide: getModelToken('Composant'), useValue: ModelMock },
        { provide: getModelToken('Di'), useValue: { updateMany: jest.fn() } },
        { provide: getModelToken('Composant_Category'), useValue: category },
        { provide: OperationalErrorService, useValue: { capture: jest.fn() } },
        { provide: GoogleDriveService, useValue: {} },
        {
          provide: DiscordHookService,
          useValue: { sendComposantCreated: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = moduleRef.get(ComposantService);
    jest.spyOn(service as any, 'generateComposantId').mockResolvedValue(42);
    upload = jest
      .spyOn(service as any, 'uploadDatasheet')
      .mockResolvedValue('https://drive/fiche.pdf');
  });

  afterEach(() => jest.restoreAllMocks());

  it('un composant réduit à son nom est enregistré avec TOUS ses champs initialisés', async () => {
    await service.createComposant({ name: 'LM317' } as any);

    expect(saved).toEqual({
      _id: 'Cmp42',
      name: 'LM317',
      package: '',
      category_composant_id: '',
      coming_date: '',
      link: '',
      pdf: '',
      status_composant: '',
      code_article: '',
      emplacement: '',
      prix_achat: 0,
      prix_vente: 0,
      quantity_stocked: 0,
      stock_min: 0,
      isDeleted: false,
    });
    expect(category.exists).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('les sentinelles « null » / « undefined » / « Invalid Date » deviennent vides', async () => {
    await service.createComposant({
      name: 'X',
      category_composant_id: 'null',
      pdf: 'null',
      link: 'undefined',
      status_composant: 'undefined',
      coming_date: 'Invalid Date',
      prix_achat: null,
      quantity_stocked: null,
    } as any);

    expect(saved).toEqual(
      expect.objectContaining({
        category_composant_id: '',
        pdf: '',
        link: '',
        status_composant: '',
        coming_date: '',
        prix_achat: 0,
        quantity_stocked: 0,
      }),
    );
    expect(category.exists).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('conserve les valeurs réellement saisies', async () => {
    await service.createComposant({
      name: 'Y',
      package: 'TO-220',
      category_composant_id: 'C_Composant3',
      prix_achat: 12.5,
      prix_vente: 20,
      quantity_stocked: 3,
      coming_date: '2026-06-10',
      status_composant: 'En stock',
      link: 'https://fournisseur/y',
      code_article: 'P0001',
      emplacement: 'AR1-01',
      stock_min: 2,
    } as any);

    expect(saved).toEqual(
      expect.objectContaining({
        package: 'TO-220',
        category_composant_id: 'C_Composant3',
        prix_achat: 12.5,
        prix_vente: 20,
        quantity_stocked: 3,
        coming_date: '2026-06-10',
        status_composant: 'En stock',
        link: 'https://fournisseur/y',
        code_article: 'P0001',
        emplacement: 'AR1-01',
        stock_min: 2,
      }),
    );
    expect(category.exists).toHaveBeenCalledWith({
      _id: 'C_Composant3',
      isDeleted: { $ne: true },
    });
  });

  it('fiche technique : data-URL téléversée ; upload en échec → vide, jamais null', async () => {
    await service.createComposant({ name: 'A', pdf: 'data:application/pdf;base64,AAAA' } as any);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(saved?.pdf).toBe('https://drive/fiche.pdf');

    upload.mockResolvedValueOnce(null);
    await service.createComposant({ name: 'B', pdf: 'data:application/pdf;base64,BBBB' } as any);
    expect(saved?.pdf).toBe('');
  });
});

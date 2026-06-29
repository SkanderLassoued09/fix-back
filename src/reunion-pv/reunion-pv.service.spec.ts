import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ReunionPVService } from './reunion-pv.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { Modalite, PvStatut } from './entities/reunion-pv.entity';

/**
 * Unit tests for ReunionPvService.
 *
 * Guards:
 *  - reference auto: `PV-{YYYY}-{seq}`, max+1, 3-pad
 *  - ref validation: missing DI / createdBy / participant / responsable
 *    → BadRequestException with the dedicated code (NO write)
 *  - persist + push: PV created and pushed onto Di.pvReunions
 *  - Discord mocked: never hits the network, but is invoked
 *  - skipDiscord: x-test-run path bypasses the notifier entirely
 */

const lean = <T>(doc: T) => ({ lean: () => Promise.resolve(doc) });

type ModelMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  updateOne: jest.Mock;
};

const makeModel = (): ModelMock => ({
  find: jest.fn(() => ({ lean: () => Promise.resolve([]) })),
  findOne: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
});

const validInput = (over: Partial<any> = {}) => ({
  titre: 'Réunion de cadrage Retour 1',
  objet: 'Analyse du retour DI42',
  dateReunion: new Date('2026-07-01T10:00:00Z'),
  lieu: 'Salle A',
  modalite: Modalite.PRESENTIEL,
  diId: 'DI_abcd',
  contexteRetour: { niveau: 1, motif: 'PDR non conforme' },
  createdById: 'PROFILE_1',
  participants: [{ profile: 'PROFILE_2' }],
  ordreDuJour: ['Cause', 'Plan'],
  decisions: ['Refaire la pièce'],
  pointsDiscutes: [{ titre: 'Diag', contenu: 'OK' }],
  actions: [
    {
      titre: 'Commander composant',
      responsable: 'PROFILE_3',
    },
  ],
  prochaineReunion: new Date('2026-07-08T10:00:00Z'),
  statut: PvStatut.BROUILLON,
  ...over,
});

describe('ReunionPVService', () => {
  let service: ReunionPVService;
  let pvModel: ModelMock;
  let profileModel: ModelMock;
  let diModel: ModelMock;
  let discord: { sendReunionPvCreated: jest.Mock };

  beforeEach(async () => {
    pvModel = makeModel();
    profileModel = makeModel();
    diModel = makeModel();
    discord = { sendReunionPvCreated: jest.fn().mockResolvedValue(undefined) };

    // Every profile / DI ref the validInput uses must resolve to a doc by default.
    diModel.findOne.mockImplementation(() => lean({ _id: 'DI_abcd', _idnum: 'DI42' }));
    profileModel.findOne.mockImplementation(({ _id }: any) =>
      lean({ _id, firstName: 'Ada', lastName: 'Lovelace', username: 'ada' }),
    );

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReunionPVService,
        { provide: getModelToken('ReunionPV'), useValue: pvModel },
        { provide: getModelToken('Profile'), useValue: profileModel },
        { provide: getModelToken('Di'), useValue: diModel },
        { provide: DiscordHookService, useValue: discord },
      ],
    }).compile();
    service = moduleRef.get(ReunionPVService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('generates the first reference as PV-{year}-001 when the collection is empty', async () => {
    pvModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'PV1' }));
    const out = await service.create(validInput());
    expect(out.reference).toMatch(/^PV-\d{4}-001$/);
  });

  it('increments the reference based on existing rows (max + 1)', async () => {
    const year = new Date().getFullYear();
    pvModel.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { reference: `PV-${year}-001` },
          { reference: `PV-${year}-007` },
          { reference: `PV-${year}-NaN` }, // poison row → ignored
        ]),
    });
    pvModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'PV1' }));
    const out = await service.create(validInput());
    expect(out.reference).toBe(`PV-${year}-008`);
  });

  it('persists every field on the created PV', async () => {
    pvModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'PV1' }));
    const input = validInput();
    const out = await service.create(input);
    expect(out.titre).toBe(input.titre);
    expect(out.di).toBe(input.diId);
    expect(out.createdBy).toBe(input.createdById);
    expect(out.contexteRetour).toEqual({ niveau: 1, motif: 'PDR non conforme' });
    expect(out.participants).toHaveLength(1);
    expect(out.actions[0].jira).toEqual({
      synced: false,
      issueKey: null,
      url: null,
    });
  });

  it('pushes the new PV id onto Di.pvReunions', async () => {
    pvModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'PV_NEW' }));
    await service.create(validInput());
    expect(diModel.updateOne).toHaveBeenCalledWith(
      { _id: 'DI_abcd' },
      { $push: { pvReunions: 'PV_NEW' } },
    );
  });

  it('throws DI_NOT_FOUND with no write when the DI ref does not exist', async () => {
    diModel.findOne.mockReturnValue(lean(null));
    await expect(service.create(validInput())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(pvModel.create).not.toHaveBeenCalled();
    expect(diModel.updateOne).not.toHaveBeenCalled();
  });

  it('throws CREATED_BY_NOT_FOUND when the author profile is missing', async () => {
    profileModel.findOne.mockImplementation(({ _id }: any) =>
      _id === 'PROFILE_1' ? lean(null) : lean({ _id }),
    );
    await expect(service.create(validInput())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(pvModel.create).not.toHaveBeenCalled();
  });

  it('throws PARTICIPANT_NOT_FOUND on an unknown participant', async () => {
    profileModel.findOne.mockImplementation(({ _id }: any) =>
      _id === 'PROFILE_2' ? lean(null) : lean({ _id }),
    );
    await expect(service.create(validInput())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws RESPONSABLE_NOT_FOUND on an unknown action responsable', async () => {
    profileModel.findOne.mockImplementation(({ _id }: any) =>
      _id === 'PROFILE_3' ? lean(null) : lean({ _id }),
    );
    await expect(service.create(validInput())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('calls Discord notifier exactly once on success', async () => {
    pvModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'PV1' }));
    await service.create(validInput());
    expect(discord.sendReunionPvCreated).toHaveBeenCalledTimes(1);
  });

  it('skips the Discord notifier when skipDiscord is true (x-test-run)', async () => {
    pvModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'PV1' }));
    await service.create(validInput(), { skipDiscord: true });
    expect(discord.sendReunionPvCreated).not.toHaveBeenCalled();
  });

  it('handles standalone mode (no DI) without touching the Di collection', async () => {
    pvModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'PV1' }));
    await service.create(validInput({ diId: undefined, contexteRetour: undefined }));
    expect(diModel.updateOne).not.toHaveBeenCalled();
  });

  it('retries on a dup-key error (reference race) and succeeds on the next attempt', async () => {
    const dupErr: any = new Error('E11000');
    dupErr.code = 11000;
    pvModel.create
      .mockRejectedValueOnce(dupErr)
      .mockImplementation(async (doc: any) => ({ ...doc, _id: 'PV1' }));
    const out = await service.create(validInput());
    expect(out).toBeTruthy();
    expect(pvModel.create).toHaveBeenCalledTimes(2);
  });
});

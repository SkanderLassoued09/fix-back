import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { GraphQLError } from 'graphql';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';
import { ComposantService } from './composant.service';
import { GoogleDriveService } from 'src/google-drive/google-drive.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';

/**
 * Unit tests for the « Enregistrer » save path (`addComposantInfo`).
 *
 * Guards:
 *  - match by `_id`, persist EVERY provided field incl. `name`;
 *  - PARTIAL update — empty/absent fields never overwrite stored values, `pdf`
 *    is left untouched unless a new base64 is sent (no more silent wipe);
 *  - renaming cascades onto the DI linkage (`array_composants[].nameComposant`);
 *  - a missing row throws a clean NOT_FOUND (never null into a non-nullable
 *    field, which used to crash and hang the spinner).
 */
type ComposantModelMock = {
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
};
type DiModelMock = { updateMany: jest.Mock };

const leanOf = (doc: unknown) => ({ lean: () => Promise.resolve(doc) });

const makeModelMock = (): ComposantModelMock => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
});

const fullInput = (overrides: Record<string, unknown> = {}) => ({
  _id: 'Cmp1',
  name: 'condo',
  package: 'cms',
  category_composant_id: 'CAT1',
  prix_achat: 1,
  prix_vente: 2,
  coming_date: '2026-06-10',
  link: 'http://parts.tn',
  quantity_stocked: 5,
  pdf: 'existing.pdf', // a stored file name, not a base64 upload
  status_composant: 'En stock',
  ...overrides,
});

describe('ComposantService.addComposantInfo', () => {
  let service: ComposantService;
  let model: ComposantModelMock;
  let di: DiModelMock;

  beforeEach(async () => {
    model = makeModelMock();
    di = { updateMany: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ComposantService,
        { provide: getModelToken('Composant'), useValue: model },
        { provide: getModelToken('Di'), useValue: di },
        { provide: OperationalErrorService, useValue: { capture: jest.fn() } },
        {
          provide: GoogleDriveService,
          useValue: {
            ensureNamedContainer: jest.fn(),
            buildDocFileName: jest.fn(),
            uploadFile: jest.fn(),
          },
        },
        // ComposantService gained a DiscordHookService dependency (create path
        // → sendComposantCreated). addComposantInfo (the tested update path)
        // never calls it, so a stub is enough to satisfy DI.
        {
          provide: DiscordHookService,
          useValue: { sendComposantCreated: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(ComposantService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('matches by _id and persists every provided field', async () => {
    model.findOne.mockReturnValue(leanOf(fullInput()));
    const saved = fullInput({ package: 'NEWPKG' });
    model.findOneAndUpdate.mockResolvedValue(saved as any);

    const res = await service.addComposantInfo(
      fullInput({ package: 'NEWPKG' }) as any,
    );

    expect(res).toBe(saved);
    const [filter, update, opts] = model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'Cmp1' });
    expect(opts).toEqual({ new: true });
    expect(update.$set.name).toBe('condo');
    expect(update.$set.package).toBe('NEWPKG');
    expect(update.$set.prix_achat).toBe(1);
  });

  it('PARTIAL: empty / null fields are NOT written (kept in DB)', async () => {
    model.findOne.mockReturnValue(leanOf(fullInput()));
    model.findOneAndUpdate.mockResolvedValue(fullInput() as any);
    await service.addComposantInfo({
      _id: 'Cmp1',
      name: 'condo',
      package: '', // cleared/empty → must be skipped
      prix_achat: null,
      quantity_stocked: 0, // a real 0 → MUST be written
    } as any);
    const set = model.findOneAndUpdate.mock.calls[0][1].$set;
    expect('package' in set).toBe(false);
    expect('prix_achat' in set).toBe(false);
    expect(set.quantity_stocked).toBe(0);
  });

  it('PDF preserved when no new base64 is supplied (no wipe)', async () => {
    model.findOne.mockReturnValue(leanOf(fullInput()));
    model.findOneAndUpdate.mockResolvedValue(fullInput() as any);
    await service.addComposantInfo(fullInput({ pdf: 'existing.pdf' }) as any);
    const set = model.findOneAndUpdate.mock.calls[0][1].$set;
    expect('pdf' in set).toBe(false); // left untouched
  });

  it('cascades a rename onto DI array_composants', async () => {
    model.findOne.mockReturnValue(leanOf(fullInput({ name: 'condo' })));
    model.findOneAndUpdate.mockResolvedValue(
      fullInput({ name: 'condo-v2' }) as any,
    );
    await service.addComposantInfo(fullInput({ name: 'condo-v2' }) as any);
    expect(di.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = di.updateMany.mock.calls[0];
    expect(filter).toEqual({ 'array_composants.nameComposant': 'condo' });
    expect(update).toEqual({
      $set: { 'array_composants.$[elem].nameComposant': 'condo-v2' },
    });
    expect(opts.arrayFilters).toEqual([{ 'elem.nameComposant': 'condo' }]);
  });

  it('does NOT cascade when the name is unchanged', async () => {
    model.findOne.mockReturnValue(leanOf(fullInput({ name: 'condo' })));
    model.findOneAndUpdate.mockResolvedValue(fullInput() as any);
    await service.addComposantInfo(fullInput({ name: 'condo' }) as any);
    expect(di.updateMany).not.toHaveBeenCalled();
  });

  it('falls back to matching by name when no _id is supplied', async () => {
    model.findOne.mockReturnValue(leanOf(fullInput()));
    model.findOneAndUpdate.mockResolvedValue(fullInput() as any);
    await service.addComposantInfo(fullInput({ _id: undefined }) as any);
    expect(model.findOne.mock.calls[0][0]).toEqual({ name: 'condo' });
  });

  it('throws a clean NOT_FOUND (not null) when no row matches', async () => {
    model.findOne.mockReturnValue(leanOf(null));
    expect.assertions(2);
    try {
      await service.addComposantInfo(fullInput({ _id: 'Cmp-missing' }) as any);
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).extensions?.code).toBe('NOT_FOUND');
    }
  });
});

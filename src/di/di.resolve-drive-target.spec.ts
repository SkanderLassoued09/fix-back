// `nanoid` (imported by di.service) is ESM-only and can't be required under
// jest/CommonJS — mock it so importing DiService doesn't blow up at load time.
jest.mock('nanoid', () => ({ nanoid: () => 'test' }));

import { GraphQLError } from 'graphql';
import { DiService } from './di.service';

/**
 * Focused unit tests for `resolveDiDriveTarget` (the Drive folder resolution
 * behind addBC/addDevis/…). Regression: a CLIENT-type DI arrives with
 * `company_id: "null"` (the literal string the FE sends for the unused entity).
 * The old code treated that as a real id → `findById("null")` → null →
 * `Company 'null' not found` (INTERNAL_SERVER_ERROR + HIGH alert).
 *
 * We build a bare instance via Object.create so we don't need the 16-arg
 * constructor — the method only touches companyModel, clientModel, drive.
 */
const leanOf = (doc: unknown) => ({ lean: () => Promise.resolve(doc) });

function makeService(opts: {
  company?: any;
  client?: any;
}): {
  svc: any;
  companyFindById: jest.Mock;
  clientFindById: jest.Mock;
  ensureEntityFolder: jest.Mock;
} {
  const companyFindById = jest.fn().mockReturnValue(leanOf(opts.company ?? null));
  const clientFindById = jest.fn().mockReturnValue(leanOf(opts.client ?? null));
  const ensureEntityFolder = jest
    .fn()
    .mockResolvedValue({ id: 'newFolder', webViewLink: 'http://drive/newFolder' });

  const svc: any = Object.create(DiService.prototype);
  // Field initializers don't fire under Object.create(prototype) — provide the
  // in-flight cache the service uses to dedupe concurrent calls.
  svc._driveTargetInFlight = new Map();
  svc.companyModel = { findById: companyFindById, updateOne: jest.fn() };
  svc.clientModel = { findById: clientFindById, updateOne: jest.fn() };
  svc.googleDriveService = { ensureEntityFolder };
  return { svc, companyFindById, clientFindById, ensureEntityFolder };
}

describe('DiService.resolveDiDriveTarget', () => {
  it('resolves the COMPANY folder for a company DI (reuses stored driveFolderId)', async () => {
    const { svc, companyFindById, clientFindById } = makeService({
      company: {
        _id: 'CMP1',
        raisonSociale: 'Excubia',
        driveFolderId: 'folderCMP1',
      },
    });
    const res = await svc.resolveDiDriveTarget({
      company_id: 'CMP1',
      client_id: 'null',
    });
    expect(res).toEqual({ folderId: 'folderCMP1', entityName: 'Excubia' });
    expect(companyFindById).toHaveBeenCalledWith('CMP1');
    expect(clientFindById).not.toHaveBeenCalled();
  });

  it('resolves the CLIENT folder when company_id is the string "null" (the bug)', async () => {
    const { svc, companyFindById, clientFindById } = makeService({
      client: {
        _id: 'C1',
        first_name: 'Jean',
        last_name: 'Dupont',
        driveFolderId: 'folderC1',
      },
    });
    const res = await svc.resolveDiDriveTarget({
      company_id: 'null', // FE sends the literal string for the unused entity
      client_id: 'C1',
    });
    expect(res).toEqual({ folderId: 'folderC1', entityName: 'Jean Dupont' });
    // The company branch must NOT be taken.
    expect(companyFindById).not.toHaveBeenCalled();
    expect(clientFindById).toHaveBeenCalledWith('C1');
  });

  it('creates + stores the client folder on demand when none yet', async () => {
    const { svc, ensureEntityFolder } = makeService({
      client: { _id: 'C2', first_name: 'A', last_name: 'B', driveFolderId: null },
    });
    // Default mock: matchedCount=1 (we won the conditional write race).
    svc.clientModel.updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const res = await svc.resolveDiDriveTarget({
      company_id: 'undefined',
      client_id: 'C2',
    });
    expect(ensureEntityFolder).toHaveBeenCalledWith('client', 'A B', expect.anything());
    expect(res.folderId).toBe('newFolder');
    expect(svc.clientModel.updateOne).toHaveBeenCalled();
  });

  // Bug: same client got duplicate Drive folders on every new DI. Concurrent
  // resolveDiDriveTarget calls for the SAME entity (which has no folder yet)
  // used to both read null + both call ensureEntityFolder → two folders. The
  // in-flight Promise cache now collapses racers onto a single create.
  it('CONCURRENT calls for the SAME entity share one ensureEntityFolder call', async () => {
    const { svc, ensureEntityFolder } = makeService({
      client: { _id: 'C3', first_name: 'Skander', last_name: 'L', driveFolderId: null },
    });
    svc.clientModel.updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const [a, b, c] = await Promise.all([
      svc.resolveDiDriveTarget({ company_id: 'null', client_id: 'C3' }),
      svc.resolveDiDriveTarget({ company_id: 'null', client_id: 'C3' }),
      svc.resolveDiDriveTarget({ company_id: 'null', client_id: 'C3' }),
    ]);
    // All 3 racers got the SAME folder id.
    expect(a.folderId).toBe('newFolder');
    expect(b.folderId).toBe('newFolder');
    expect(c.folderId).toBe('newFolder');
    // Drive was hit EXACTLY ONCE — the other 2 awaited the in-flight Promise.
    expect(ensureEntityFolder).toHaveBeenCalledTimes(1);
    expect(svc.clientModel.updateOne).toHaveBeenCalledTimes(1);
  });

  // If another writer (or process) won the conditional write, we re-read and
  // return THEIR id. Prevents a stale duplicate id leaking into the DI's docs.
  it('lost the conditional-write race → re-reads and returns the winning id', async () => {
    const company = {
      _id: 'CMP3',
      raisonSociale: 'Acme',
      driveFolderId: null, // first read: empty
    };
    const { svc, ensureEntityFolder } = makeService({ company });
    // Lost the race (matchedCount: 0). Refetch returns the OTHER writer's id.
    svc.companyModel.updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 });
    svc.companyModel.findById = jest
      .fn()
      // 1st findById (initial read): empty driveFolderId
      .mockReturnValueOnce(leanOf(company))
      // 2nd findById (refetch after lost race): winner's id
      .mockReturnValueOnce(leanOf({ ...company, driveFolderId: 'WINNER' }));
    const res = await svc.resolveDiDriveTarget({
      company_id: 'CMP3',
      client_id: 'null',
    });
    expect(ensureEntityFolder).toHaveBeenCalledTimes(1);
    // Returned id = winner's, NOT our newly-created folder.
    expect(res.folderId).toBe('WINNER');
  });

  it('throws a clean BAD_REQUEST (no "Company") when NO entity is resolvable', async () => {
    const { svc } = makeService({});
    expect.assertions(3);
    try {
      await svc.resolveDiDriveTarget({ company_id: 'null', client_id: 'null' });
    } catch (e: any) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect(e.extensions?.code).toBe('BAD_REQUEST');
      expect(e.message).not.toMatch(/Company/i);
    }
  });

  it('throws a clean BAD_REQUEST "Société introuvable" (not a 500) when the company id is unknown', async () => {
    const { svc } = makeService({ company: null }); // findById → null
    expect.assertions(3);
    try {
      await svc.resolveDiDriveTarget({ company_id: 'CMP9' });
    } catch (e: any) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect(e.extensions?.code).toBe('BAD_REQUEST');
      expect(e.message).toMatch(/Société introuvable/);
    }
  });
});

describe('DiService.uploadDiDocToDrive — stale folder auto-repair', () => {
  const B64 = 'data:application/pdf;base64,QQ=='; // tiny pdf data-URL

  function makeUploadSvc(uploadFile: jest.Mock, isNotFound: boolean) {
    const company = {
      _id: 'CMP1',
      raisonSociale: 'Excubia',
      driveFolderId: 'STALE', // created by the old service account → 404 today
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const companyUpdateOne = jest.fn();
    const ensureEntityFolder = jest
      .fn()
      .mockResolvedValue({ id: 'FRESH', webViewLink: 'http://drive/FRESH' });
    const capture = jest.fn();
    const svc: any = Object.create(DiService.prototype);
    svc._driveTargetInFlight = new Map();
    svc.companyModel = {
      findById: jest.fn().mockReturnValue(leanOf(company)),
      updateOne: companyUpdateOne,
    };
    svc.clientModel = { findById: jest.fn(), updateOne: jest.fn() };
    svc.googleDriveService = {
      ensureEntityFolder,
      buildDocFileName: jest.fn().mockReturnValue('Excubia_BC_x.pdf'),
      uploadFile,
      isNotFoundError: jest.fn().mockReturnValue(isNotFound),
    };
    svc.operationalErrorService = { capture };
    return { svc, ensureEntityFolder, companyUpdateOne, capture };
  }

  it('recreates the folder under OAuth and retries the upload when the stored folder 404s', async () => {
    const notFound = Object.assign(new Error('File not found: STALE'), {
      code: 404,
    });
    const uploadFile = jest
      .fn()
      .mockRejectedValueOnce(notFound) // stored (stale) folder → 404
      .mockResolvedValueOnce({
        id: 'FILE1',
        webViewLink: 'http://drive/FILE1',
        name: 'Excubia_BC_x.pdf',
      }); // retry into the fresh folder → ok
    const { svc, ensureEntityFolder, companyUpdateOne, capture } =
      makeUploadSvc(uploadFile, true);

    const res = await svc.uploadDiDocToDrive(
      { _id: 'DI1', company_id: 'CMP1', client_id: 'null' },
      B64,
      'BC',
    );

    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(uploadFile.mock.calls[0][0]).toBe('STALE'); // first try → stale id
    expect(ensureEntityFolder).toHaveBeenCalledWith(
      'company',
      'Excubia',
      expect.anything(),
    );
    expect(companyUpdateOne).toHaveBeenCalled(); // fresh id persisted
    expect(uploadFile.mock.calls[1][0]).toBe('FRESH'); // retry → fresh id
    expect(res).toEqual({
      webViewLink: 'http://drive/FILE1',
      driveFileId: 'FILE1',
      fileName: 'Excubia_BC_x.pdf',
    });
    // auto-repair logged LOW, no Discord
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'LOW', notify: false }),
    );
  });

  it('does NOT recreate/retry on a non-404 error (propagates, single attempt)', async () => {
    const boom = new Error('quota / network / etc.');
    const uploadFile = jest.fn().mockRejectedValue(boom);
    const { svc, ensureEntityFolder } = makeUploadSvc(uploadFile, false);

    await expect(
      svc.uploadDiDocToDrive(
        { _id: 'DI1', company_id: 'CMP1', client_id: 'null' },
        B64,
        'BC',
      ),
    ).rejects.toThrow(boom);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(ensureEntityFolder).not.toHaveBeenCalled();
  });
});

describe('DiService.generateClientId — robust DI{n} numbering (no DINaN)', () => {
  function svcWithIds(rows: Array<{ _idnum: string }>) {
    const s: any = Object.create(DiService.prototype);
    s.diModel = {
      find: jest.fn().mockReturnValue({ lean: () => Promise.resolve(rows) }),
    };
    return s;
  }

  it('returns max(valid)+1, ignoring non-DI{n} ids (INMAG-, LIFE-, DINaN)', async () => {
    const s = svcWithIds([
      { _idnum: 'DI5' },
      { _idnum: 'INMAG-mqjdgh0a' },
      { _idnum: 'DI7' },
      { _idnum: 'LIFE-xyz' },
      { _idnum: 'DINaN' },
    ]);
    expect(await s.generateClientId()).toBe(8);
  });

  it('falls back to 1 when no conforming ids — never NaN', async () => {
    const s = svcWithIds([
      { _idnum: 'INMAG-a' },
      { _idnum: 'DINaN' },
      { _idnum: 'DI' },
    ]);
    const n = await s.generateClientId();
    expect(n).toBe(1);
    expect(Number.isNaN(n)).toBe(false);
  });

  it('returns 1 on an empty collection', async () => {
    expect(await svcWithIds([]).generateClientId()).toBe(1);
  });
});

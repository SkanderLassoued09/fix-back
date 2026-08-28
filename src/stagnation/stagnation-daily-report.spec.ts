import { StagnationDailyReportService } from './stagnation-daily-report.service';
import { StagnationService } from './stagnation.service';

/**
 * Rapport quotidien de stagnation — logique d'orchestration + IDÉMPOTENCE.
 * La détection par seuil (22h/24h/48h) s'appuie sur la requête Mongo
 * `statusUpdatedAt <= now-24h` (couverte par l'intégration réelle) ; ici on
 * prouve : mapping, réservation idempotente, appels de livraison (feuille +
 * DAILY_REMINDER + Discord APP_ALERT), no-op quand tout est déjà dispatché,
 * et best-effort quand la feuille échoue.
 */

const DUP = Object.assign(new Error('E11000 dup'), { code: 11000 });

function makeSvc(
  stagnant: Array<{ _id: string; idNum: string; status: string; ageHours: number; statusChangedAt: Date }>,
  createImpl?: jest.Mock,
) {
  const svc: any = Object.create(StagnationDailyReportService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.stagnationService = {
    getStagnantForDailyReport: jest.fn().mockResolvedValue(stagnant),
  };
  svc.sheets = {
    appendRows: jest.fn().mockResolvedValue(undefined),
    getSheetGid: jest.fn().mockResolvedValue(186643629),
  };
  svc.notificationService = { emit: jest.fn().mockResolvedValue({}) };
  svc.discord = { sendDailyStagnationReminder: jest.fn().mockResolvedValue(undefined) };
  svc.dispatchModel = { create: createImpl ?? jest.fn().mockResolvedValue({}) };
  return svc;
}

const di = (idNum: string, status: string, ageHours = 30) => ({
  _id: `id_${idNum}`,
  idNum,
  status,
  ageHours,
  statusChangedAt: new Date(Date.now() - ageHours * 3600_000),
});

describe('StagnationDailyReportService.run — orchestration & idempotence', () => {
  it('premier run : feuille FR (durée réelle) + 1 résumé DAILY_REMINDER + 1 Discord', async () => {
    // DI-1 stagnante depuis 246h (= 10 jours pleins), DI-5 depuis 30h (= 1 jour).
    const svc = makeSvc([
      di('DI-1', 'WAITING_DEVIS', 246),
      di('DI-5', 'WAITING_BC', 30),
    ]);
    const res = await svc.run();

    expect(res.dispatched).toBe(2);
    // Feuille : 1 appel, 2 lignes, entête FR exact, range = date!A:E.
    expect(svc.sheets.appendRows).toHaveBeenCalledTimes(1);
    const [range, rows, header] = svc.sheets.appendRows.mock.calls[0];
    expect(range).toMatch(/^\d{4}-\d{2}-\d{2}!A:E$/);
    expect(header).toEqual(['ID :', 'Statut', 'Durée', 'Unité', 'Message']);
    expect(rows).toHaveLength(2);
    // Durée RÉELLE, unité adaptée, message FR (pluriel « jours »).
    expect(rows[0]).toEqual([
      'DI-1',
      'WAITING_DEVIS',
      10,
      'jours',
      'DI DI-1 stagnante dans le statut WAITING_DEVIS depuis 10 jours.',
    ]);
    // Singulier « jour » sur 30h.
    expect(rows[1]).toEqual([
      'DI-5',
      'WAITING_BC',
      1,
      'jour',
      'DI DI-5 stagnante dans le statut WAITING_BC depuis 1 jour.',
    ]);
    // ERP : UN résumé DAILY_REMINDER (pas une notif par DI), vers les 4 rôles.
    expect(svc.notificationService.emit).toHaveBeenCalledTimes(1);
    expect(svc.notificationService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DAILY_REMINDER',
        notify: {
          roles: ['Coordinator', 'Manager', 'Admin_Manager', 'Admin_Tech'],
        },
      }),
    );
    // Discord : UN seul embed APP_ALERT (seuil en FR : « heures »).
    expect(svc.discord.sendDailyStagnationReminder).toHaveBeenCalledTimes(1);
    expect(svc.discord.sendDailyStagnationReminder).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, seuil: 24, unite: 'heures' }),
    );
  });

  it('le rappel porte le lien PROFOND vers l’onglet du jour (gid) — Discord + cloche', async () => {
    const prev = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'SHEET_X';
    try {
      const svc = makeSvc([di('DI-1', 'WAITING_DEVIS', 246)]);
      await svc.run();
      const url =
        'https://docs.google.com/spreadsheets/d/SHEET_X/edit?gid=186643629#gid=186643629';
      expect(svc.sheets.getSheetGid).toHaveBeenCalledWith(
        'SHEET_X',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
      expect(svc.discord.sendDailyStagnationReminder).toHaveBeenCalledWith(
        expect.objectContaining({ spreadsheetUrl: url }),
      );
      expect(svc.notificationService.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ url }),
        }),
      );
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      else process.env.GOOGLE_SHEETS_SPREADSHEET_ID = prev;
    }
  });

  it('idempotent : ré-run le même jour (clé dupliquée) → aucune livraison', async () => {
    const create = jest.fn().mockRejectedValue(DUP); // toutes déjà dispatchées
    const svc = makeSvc([di('DI-1', 'WAITING_DEVIS'), di('DI-5', 'WAITING_BC')], create);
    const res = await svc.run();

    expect(res.dispatched).toBe(0);
    expect(res.skipped).toBe(2);
    expect(svc.sheets.appendRows).not.toHaveBeenCalled();
    expect(svc.notificationService.emit).not.toHaveBeenCalled();
    expect(svc.discord.sendDailyStagnationReminder).not.toHaveBeenCalled();
  });

  it('idempotence PARTIELLE : seules les DI non encore dispatchées sont livrées', async () => {
    // DI-1 déjà dispatchée (dup), DI-5 nouvelle.
    const create = jest
      .fn()
      .mockRejectedValueOnce(DUP)
      .mockResolvedValueOnce({});
    const svc = makeSvc([di('DI-1', 'WAITING_DEVIS'), di('DI-5', 'WAITING_BC')], create);
    const res = await svc.run();

    expect(res.dispatched).toBe(1);
    expect(svc.notificationService.emit).toHaveBeenCalledTimes(1);
    expect(svc.sheets.appendRows.mock.calls[0][1]).toHaveLength(1); // 1 ligne
  });

  it('rien de stagnant → aucun effet de bord', async () => {
    const svc = makeSvc([]);
    const res = await svc.run();
    expect(res.dispatched).toBe(0);
    expect(svc.sheets.appendRows).not.toHaveBeenCalled();
    expect(svc.discord.sendDailyStagnationReminder).not.toHaveBeenCalled();
  });

  it('best-effort : un échec feuille ne bloque PAS les notifs ni le Discord', async () => {
    const svc = makeSvc([di('DI-1', 'WAITING_DEVIS')]);
    svc.sheets.appendRows.mockRejectedValue(new Error('Sheets 500'));
    const res = await svc.run();
    expect(res.dispatched).toBe(1);
    expect(svc.notificationService.emit).toHaveBeenCalledTimes(1);
    expect(svc.discord.sendDailyStagnationReminder).toHaveBeenCalledTimes(1);
  });

  it('une vraie erreur DB (non 11000) remonte', async () => {
    const create = jest.fn().mockRejectedValue(new Error('DB down'));
    const svc = makeSvc([di('DI-1', 'WAITING_DEVIS')], create);
    await expect(svc.run()).rejects.toThrow('DB down');
  });
});

describe('StagnationService.getStagnantForDailyReport — seuil 24h + mapping', () => {
  function makeStag(returned: any[]) {
    const svc: any = Object.create(StagnationService.prototype);
    const chain = {
      select: () => chain,
      sort: () => chain,
      lean: () => Promise.resolve(returned),
    };
    const find = jest.fn().mockReturnValue(chain);
    svc.diModel = { find };
    return { svc, find };
  }

  it('requête filtrée à 24h (statusUpdatedAt <= now-24h) + repli updatedAt', async () => {
    const { svc, find } = makeStag([]);
    const before = Date.now();
    await svc.getStagnantForDailyReport(24);
    const q = find.mock.calls[0][0];
    // Le seuil de coupe est ~24h avant maintenant.
    const cutoff = q.$or[0].statusUpdatedAt.$lte.getTime();
    const expected = before - 24 * 3600_000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000);
    // Repli legacy : statusUpdatedAt null → updatedAt.
    expect(q.$or[1]).toEqual(
      expect.objectContaining({ statusUpdatedAt: null }),
    );
    // Statuts terminaux exclus.
    expect(q.status.$nin.length).toBeGreaterThan(0);
  });

  it('mapping : idNum, status, ageHours dérivés de statusUpdatedAt', async () => {
    const changedAt = new Date(Date.now() - 30 * 3600_000);
    const { svc } = makeStag([
      { _id: 'x1', _idnum: 'DI-9', status: 'WAITING_BC', statusUpdatedAt: changedAt },
    ]);
    const out = await svc.getStagnantForDailyReport(24);
    expect(out[0]).toEqual(
      expect.objectContaining({ idNum: 'DI-9', status: 'WAITING_BC' }),
    );
    expect(out[0].ageHours).toBeGreaterThanOrEqual(29);
    expect(out[0].ageHours).toBeLessThanOrEqual(31);
  });
});

import { DiscordHookService } from './discord-hook.service';

/**
 * Coupe-circuit OUVERT (DISCORD_NOTIFS_DISABLED = false) + routage des salons :
 *   - tout le flux (DI, documents, catalogue, PV, réunions) → GENERAL_ATELIER ;
 *   - rappel stock magasin → DEMANDE_PDF (salon « demande PDR ») ;
 *   - erreurs → ERROR ; alertes (stagnation, sauvegarde BDD, DiArchive) → APP_ALERT.
 *
 * On espionne `deliverEmbed` (l'envoi bas-niveau réel) : c'est lui, et le salon
 * qu'il reçoit, qui part vers Discord.
 */
describe('DiscordHookService — gate + routage des salons', () => {
  // Modèle Mongoose factice tolérant (findOne().lean() / .select().lean()).
  const model = {
    findOne: () => ({
      lean: () => Promise.resolve(null),
      select: () => ({ lean: () => Promise.resolve(null) }),
    }),
  } as any;

  function makeSvc() {
    const svc = new DiscordHookService(model, model, model, model);
    const deliver = jest
      .spyOn(svc as any, 'deliverEmbed')
      .mockResolvedValue(undefined);
    return { svc, deliver };
  }

  afterEach(() => jest.restoreAllMocks());

  const di = {
    _id: 'd1',
    _idnum: 'DI1',
    title: 't',
    status: 'INDIAGNOSTIC',
    ignoreCount: 1,
  };

  it('gate OUVERT : postEmbed délivre', async () => {
    const { svc, deliver } = makeSvc();
    await svc.postEmbed('GENERAL_ATELIER', { embeds: [] });
    expect(deliver).toHaveBeenCalledWith('GENERAL_ATELIER', { embeds: [] });
  });

  const generalSenders: Array<[string, (s: DiscordHookService) => Promise<void>]> = [
    ['sendDiPendingNotification', (s) => s.sendDiPendingNotification(di)],
    ['sendDiAssignedToTech', (s) => s.sendDiAssignedToTech({ di, stat: {}, technician: 'p1' })],
    ['sendComponentsSentToCoordinator', (s) => s.sendComponentsSentToCoordinator(di)],
    ['sendComponentsConfirmedByCoordinator', (s) => s.sendComponentsConfirmedByCoordinator(di)],
    ['sendDiInMagasin', (s) => s.sendDiInMagasin(di)],
    ['sendDiStatusPending3', (s) => s.sendDiStatusPending3(di)],
    ['sendDiDevisUploaded', (s) => s.sendDiDevisUploaded({ di, fileName: 'devis.pdf' })],
    ['sendDiBCUploaded', (s) => s.sendDiBCUploaded({ di, fileName: 'bc.pdf' })],
    ['sendDiBLUploaded', (s) => s.sendDiBLUploaded({ di, fileName: 'bl.pdf' })],
    ['sendDiPriceAssigned', (s) => s.sendDiPriceAssigned({ di, price: 10 })],
    ['sendDiStatusPending2', (s) => s.sendDiStatusPending2(di)],
    ['sendDiPricing', (s) => s.sendDiPricing(di)],
    ['sendDiStatusPending1', (s) => s.sendDiStatusPending1(di)],
    ['sendDiIgnored', (s) => s.sendDiIgnored(di)],
    ['sendDiFinished', (s) => s.sendDiFinished(di)],
    ['sendDiIrreparable', (s) => s.sendDiIrreparable(di)],
    ['sendDiInReparation', (s) => s.sendDiInReparation(di)],
    ['sendDiagnosticFinished', (s) => s.sendDiagnosticFinished({ di, diag: {} })],
    ['sendDiagnosticPaused', (s) => s.sendDiagnosticPaused(di)],
    ['sendDiagnosticResumed', (s) => s.sendDiagnosticResumed(di)],
    ['sendDiagnosticStarted', (s) => s.sendDiagnosticStarted(di)],
    ['sendDiagnosticAssigned', (s) => s.sendDiagnosticAssigned(di, 'p1')],
    ['sendReparationStarted', (s) => s.sendReparationStarted(di)],
    ['sendReparationPaused', (s) => s.sendReparationPaused(di)],
    ['sendReparationResumed', (s) => s.sendReparationResumed(di)],
    ['sendReparationAssigned', (s) => s.sendReparationAssigned({ di, technician: 'p1' })],
    ['sendDiNegotiation1', (s) => s.sendDiNegotiation1(di)],
    ['sendDiNegotiation2', (s) => s.sendDiNegotiation2(di)],
    ['sendDiCancelled', (s) => s.sendDiCancelled(di)],
    ['sendDiAbandoned', (s) => s.sendDiAbandoned(di, 'motif')],
    ['sendDiRetour', (s) => s.sendDiRetour(di, 1)],
    ['sendComposantCreated', (s) => s.sendComposantCreated({ composant: { name: 'R1' } })],
    ['sendReunionPvCreated', (s) => s.sendReunionPvCreated({ pv: { reference: 'PV-1', titre: 'R' } })],
    ['sendReunionReminder', (s) => s.sendReunionReminder({ pv: { reference: 'PV-1', titre: 'R' } })],
  ];

  it.each(generalSenders)('%s → GENERAL_ATELIER', async (_name, send) => {
    const { svc, deliver } = makeSvc();
    await send(svc);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('GENERAL_ATELIER', expect.anything());
  });

  it('sendMagasinStockReminder → DEMANDE_PDF (salon « demande PDR »)', async () => {
    const { svc, deliver } = makeSvc();
    await svc.sendMagasinStockReminder({
      threshold: 5,
      rupture: { count: 1, examples: '• R1' },
      low: { count: 0, examples: '' },
      incomplete: { affected: 0, status: 0, price: 0, qty: 0, examples: '' },
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('DEMANDE_PDF', expect.anything());
  });

  it('sendOperationalError → ERROR', async () => {
    const { svc, deliver } = makeSvc();
    await svc.sendOperationalError({
      timestamp: new Date().toISOString(),
      module: 'di',
      submodule: 'diService',
      method: 'X',
      severity: 'HIGH',
      error: 'boom',
      message: 'boom',
    });
    expect(deliver).toHaveBeenCalledWith('ERROR', expect.anything());
  });

  const alertSenders: Array<[string, (s: DiscordHookService) => Promise<void>]> = [
    [
      'sendStagnationAlert',
      (s) =>
        s.sendStagnationAlert({
          _id: 'a1',
          diId: 'DI1',
          type: 'DI_STAGNANT_48H',
          severity: 'WARNING',
          message: 'DI stagnante',
          // createdAt requis : `.toISOString()` sur un createdAt undefined plante.
          createdAt: new Date(),
        }),
    ],
    ['sendStagnationDigest', (s) => s.sendStagnationDigest({ total: 0, buckets: [] })],
    [
      'sendDailyStagnationReminder',
      (s) =>
        s.sendDailyStagnationReminder({
          date: '2026-09-14',
          count: 1,
          seuil: 24,
          unite: 'heures',
          examples: [],
        }),
    ],
    ['sendDiArchiveDigest', (s) => s.sendDiArchiveDigest('digest')],
    [
      'sendDbBackupSuccess',
      (s) =>
        s.sendDbBackupSuccess({
          fileName: 'f.gz',
          dbName: 'db',
          sizeBytes: 1,
          durationMs: 1,
          folderName: 'BACKUPS_DEV',
        }),
    ],
    ['sendDbBackupFailure', (s) => s.sendDbBackupFailure({ reason: 'r' })],
  ];

  it.each(alertSenders)('%s → APP_ALERT', async (_name, send) => {
    const { svc, deliver } = makeSvc();
    await send(svc);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('APP_ALERT', expect.anything());
  });

  it('isPvConfigured suit APP_ALERT (salon du digest Jira), plus SERVICE_TECHNIQUE', () => {
    const oldAlert = process.env.DISCORD_APP_ALERT_WEBHOOK;
    const oldTech = process.env.DISCORD_SERVICE_TECHNIQUE_WEBHOOK;
    try {
      const { svc } = makeSvc();
      process.env.DISCORD_SERVICE_TECHNIQUE_WEBHOOK = 'https://discord.test/tech';
      delete process.env.DISCORD_APP_ALERT_WEBHOOK;
      expect(svc.isPvConfigured).toBe(false);
      delete process.env.DISCORD_SERVICE_TECHNIQUE_WEBHOOK;
      process.env.DISCORD_APP_ALERT_WEBHOOK = 'https://discord.test/alert';
      expect(svc.isPvConfigured).toBe(true);
    } finally {
      if (oldAlert === undefined) delete process.env.DISCORD_APP_ALERT_WEBHOOK;
      else process.env.DISCORD_APP_ALERT_WEBHOOK = oldAlert;
      if (oldTech === undefined) delete process.env.DISCORD_SERVICE_TECHNIQUE_WEBHOOK;
      else process.env.DISCORD_SERVICE_TECHNIQUE_WEBHOOK = oldTech;
    }
  });
});

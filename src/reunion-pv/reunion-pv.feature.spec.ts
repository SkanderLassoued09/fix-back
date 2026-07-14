import { ReunionPVService } from './reunion-pv.service';

/**
 * Feature tests for the 2-phase Réunion module (direct instantiation with
 * mocked models — the codebase's Nest TestingModule can't resolve Mongoose
 * tokens, same pattern as di-workflow.service.spec).
 */

const lean = (value: any) => ({ lean: () => Promise.resolve(value) });

function makeService() {
  const reunionPVModel: any = {
    find: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({}),
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
  };
  const profileModel: any = { findOne: jest.fn() };
  const diModel: any = { findOne: jest.fn(), updateOne: jest.fn() };
  const discordHook: any = {
    sendReunionPvCreated: jest.fn().mockResolvedValue(undefined),
    sendReunionReminder: jest.fn().mockResolvedValue(undefined),
  };
  const jiraService: any = {
    isConfigured: false,
    createIssueForAction: jest.fn(),
    updateIssueForAction: jest.fn(),
  };
  const service = new ReunionPVService(
    reunionPVModel,
    profileModel,
    diModel,
    discordHook,
    jiraService,
  );
  return { service, reunionPVModel, profileModel, diModel, discordHook, jiraService };
}

describe('ReunionPVService — light creation', () => {
  it('persists the PV and fires the Discord creation notification', async () => {
    const t = makeService();
    t.reunionPVModel.find.mockReturnValue(lean([])); // nextReference → seq 1
    t.reunionPVModel.create.mockImplementation((doc: any) =>
      Promise.resolve({ _id: 'pv1', ...doc }),
    );
    t.profileModel.findOne.mockReturnValue(
      lean({ _id: 'u1', firstName: 'A', lastName: 'B' }),
    );
    t.jiraService.isConfigured = false; // no Jira side-effect on create

    const res = await t.service.create({
      titre: 'Réunion Q3',
      dateReunion: new Date('2026-08-01T09:00:00Z'),
      createdById: 'u1',
      participants: [{ profile: 'u1' } as any],
    } as any);

    expect(res._id).toBe('pv1');
    expect(t.reunionPVModel.create).toHaveBeenCalledTimes(1);
    expect(t.discordHook.sendReunionPvCreated).toHaveBeenCalledTimes(1);
  });

  it('skips Discord when skipDiscord option is set (QA runs)', async () => {
    const t = makeService();
    t.reunionPVModel.find.mockReturnValue(lean([]));
    t.reunionPVModel.create.mockImplementation((doc: any) =>
      Promise.resolve({ _id: 'pv2', ...doc }),
    );
    t.profileModel.findOne.mockReturnValue(lean({ _id: 'u1' }));

    await t.service.create(
      { titre: 'T', dateReunion: new Date(), createdById: 'u1' } as any,
      { skipDiscord: true, skipJira: true },
    );
    expect(t.discordHook.sendReunionPvCreated).not.toHaveBeenCalled();
  });
});

describe('ReunionPVService — Jira sync idempotence (update-not-duplicate)', () => {
  it('UPDATES an action that already has an issueKey, CREATES one that does not', async () => {
    const t = makeService();
    t.jiraService.isConfigured = true;
    t.jiraService.updateIssueForAction.mockResolvedValue({
      issueKey: 'FIX-1',
      url: 'u1',
      assigned: true,
    });
    t.jiraService.createIssueForAction.mockResolvedValue({
      issueKey: 'FIX-2',
      url: 'u2',
      assigned: true,
    });
    const saved: any = {
      _id: 'pv1',
      toObject: () => ({
        reference: 'PV-2026-001',
        titre: 'T',
        actions: [
          { _id: 'a1', titre: 'A1', jira: { issueKey: 'FIX-1', synced: true } },
          { _id: 'a2', titre: 'A2', jira: {} },
        ],
      }),
    };

    await (t.service as any).syncActionsToJira(saved);

    expect(t.jiraService.updateIssueForAction).toHaveBeenCalledTimes(1);
    expect(t.jiraService.updateIssueForAction).toHaveBeenCalledWith(
      'FIX-1',
      expect.objectContaining({ titre: 'A1' }),
      expect.objectContaining({ reference: 'PV-2026-001' }),
    );
    expect(t.jiraService.createIssueForAction).toHaveBeenCalledTimes(1);

    const written = t.reunionPVModel.updateOne.mock.calls[0][1].$set.actions;
    expect(written[0].jira.issueKey).toBe('FIX-1'); // same issue, updated
    expect(written[1].jira.issueKey).toBe('FIX-2'); // new issue
  });

  it('email not a Jira user → task created UNASSIGNED + jira.assignFailed=true, no throw', async () => {
    const t = makeService();
    t.jiraService.isConfigured = true;
    t.profileModel.findOne.mockReturnValue(
      lean({ _id: 'u3', email: 'ghost@nope.io' }),
    );
    t.jiraService.createIssueForAction.mockResolvedValue({
      issueKey: 'FIX-3',
      url: 'u3',
      assigned: false, // Jira couldn't map the email
    });
    const saved: any = {
      _id: 'pv1',
      toObject: () => ({
        reference: 'PV-2026-002',
        titre: 'T',
        actions: [{ _id: 'a3', titre: 'A3', responsable: 'u3', jira: {} }],
      }),
    };

    await expect((t.service as any).syncActionsToJira(saved)).resolves.toBeUndefined();

    const written = t.reunionPVModel.updateOne.mock.calls[0][1].$set.actions;
    expect(written[0].jira.issueKey).toBe('FIX-3'); // never lost
    expect(written[0].jira.assignFailed).toBe(true);
  });
});

describe('ReunionPVService — REUNION_REMINDER idempotence', () => {
  const pv = {
    _id: 'pv1',
    reference: 'PV-2026-001',
    titre: 'T',
    dateReunion: new Date(),
    participants: [],
  };

  it('meeting in-window not yet reminded → sends + claims reminderSent', async () => {
    const t = makeService();
    t.reunionPVModel.find.mockReturnValue(lean([pv]));
    t.reunionPVModel.findOneAndUpdate.mockResolvedValue(pv); // claim succeeds

    const res = await t.service.sendDueReminders(new Date());

    expect(res.sent).toBe(1);
    expect(t.reunionPVModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'pv1', reminderSent: { $ne: true } },
      { $set: { reminderSent: true } },
      { new: true },
    );
    expect(t.discordHook.sendReunionReminder).toHaveBeenCalledTimes(1);
  });

  it('re-run: already claimed (findOneAndUpdate null) → NO second notification', async () => {
    const t = makeService();
    t.reunionPVModel.find.mockReturnValue(lean([pv]));
    t.reunionPVModel.findOneAndUpdate.mockResolvedValue(null); // lost the claim

    const res = await t.service.sendDueReminders(new Date());

    expect(res.sent).toBe(0);
    expect(t.discordHook.sendReunionReminder).not.toHaveBeenCalled();
  });

  it('no meeting in the window → nothing sent', async () => {
    const t = makeService();
    t.reunionPVModel.find.mockReturnValue(lean([]));

    const res = await t.service.sendDueReminders(new Date());

    expect(res.candidates).toBe(0);
    expect(res.sent).toBe(0);
    expect(t.reunionPVModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('Discord send fails → reminderSent reverted so it retries', async () => {
    const t = makeService();
    t.reunionPVModel.find.mockReturnValue(lean([pv]));
    t.reunionPVModel.findOneAndUpdate.mockResolvedValue(pv);
    t.discordHook.sendReunionReminder.mockRejectedValue(new Error('hook down'));

    const res = await t.service.sendDueReminders(new Date());

    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(t.reunionPVModel.updateOne).toHaveBeenCalledWith(
      { _id: 'pv1' },
      { $set: { reminderSent: false } },
    );
  });
});

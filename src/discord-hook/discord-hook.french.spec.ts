import { DiscordHookService } from './discord-hook.service';

/**
 * Verifies the Discord notifications render in FRENCH — titles, field labels
 * and status values — and never leak the old English wording. Uses Object.create
 * to skip the Mongo-model constructor; `postEmbed` is spied so no HTTP happens.
 */
function makeSvc() {
  const svc: any = Object.create(DiscordHookService.prototype);
  svc.postEmbed = jest.fn().mockResolvedValue(undefined);
  svc.clientModel = {};
  svc.companyModel = {};
  svc.profileModel = {};
  return svc;
}

const ENGLISH = /\b(Assigned|Technician|Title|Status|Number|Pending|Completed|Started|Paused|Resumed|Cancelled|Uploaded|Ignored|Coordinator assigned|Repair process)\b/;

describe('Discord notifications — French', () => {
  it('sendDiagnosticAssigned: French title/description/labels + status value', async () => {
    const svc = makeSvc();
    await svc.sendDiagnosticAssigned(
      { _idnum: 'T277', title: 'skander', company_id: { name: 'Skn' }, status: 'DIAGNOSTIC' },
      { firstName: 'tech' },
    );
    const embed = svc.postEmbed.mock.calls[0][1].embeds[0];

    expect(embed.title).toBe('🧭 Diagnostic affecté');
    expect(embed.description).toContain('coordinatrice');
    const names = embed.fields.map((f: any) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(['🆔 N° DI', '📄 Titre', '📊 Statut', '👨‍🔧 Technicien']),
    );
    const statut = embed.fields.find((f: any) => f.name === '📊 Statut');
    expect(statut.value).toBe('🧭 Diagnostic affecté'); // French status value
    expect(JSON.stringify(embed)).not.toMatch(ENGLISH);
  });

  it('sendDiFinished: French title + base labels', async () => {
    const svc = makeSvc();
    await svc.sendDiFinished({
      _idnum: 'T1',
      title: 't',
      company_id: { name: 'C' },
      status: 'FINISHED',
      price: 100,
    });
    const embed = svc.postEmbed.mock.calls[0][1].embeds[0];

    expect(embed.title).toBe('🎉 DI terminée');
    expect(embed.fields.map((f: any) => f.name)).toEqual(
      expect.arrayContaining(['🆔 N° DI', '📄 Titre', '📊 Statut', '💵 Prix final']),
    );
    expect(JSON.stringify(embed)).not.toMatch(ENGLISH);
  });

  it('sendReunionPvCreated: already French (regression)', async () => {
    const svc = makeSvc();
    await svc.sendReunionPvCreated({
      pv: { reference: 'PV-2026-001', titre: 'Réunion', dateReunion: new Date('2026-08-01') },
      profile: { firstName: 'A', lastName: 'B' },
    });
    const embed = svc.postEmbed.mock.calls[0][1].embeds[0];
    expect(embed.title).toBe('📄 Procès-Verbal de Réunion');
    expect(JSON.stringify(embed)).not.toMatch(ENGLISH);
  });

  it('resolveStatusLabel returns French labels', () => {
    const svc = makeSvc();
    expect(svc.resolveStatusLabel('INREPARATION')).toBe('🔧 En réparation');
    expect(svc.resolveStatusLabel('PENDING1')).toBe('🟡 En attente diagnostic');
    expect(svc.resolveStatusLabel(null)).toBe('Inconnu');
  });
});

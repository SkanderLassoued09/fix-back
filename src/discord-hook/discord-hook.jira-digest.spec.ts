jest.mock('axios');
import axios from 'axios';
import { DiscordHookService } from './discord-hook.service';

/**
 * Focused test for the grouped Jira digest embed (axios mocked — no network).
 * Proves the SYNC_JIRA_DUE_SOON notification is ONE embed sectioned by
 * responsable (one field per responsable, each listing its tasks as links),
 * posted to the DEDICATED APP_ALERT channel (no legacy fallback).
 */
describe('DiscordHookService.sendJiraTasksDigest', () => {
  const OLD_APP_ALERT = process.env.DISCORD_APP_ALERT_WEBHOOK;

  beforeEach(() => {
    (axios.post as jest.Mock).mockReset();
    (axios.post as jest.Mock).mockResolvedValue({ data: {} });
    process.env.DISCORD_APP_ALERT_WEBHOOK = 'https://discord.test/webhook';
  });
  afterAll(() => {
    if (OLD_APP_ALERT === undefined) delete process.env.DISCORD_APP_ALERT_WEBHOOK;
    else process.env.DISCORD_APP_ALERT_WEBHOOK = OLD_APP_ALERT;
  });

  // Constructor models are unused by this method → harmless stubs.
  const svc = () => new DiscordHookService({} as any, {} as any, {} as any);

  it('UN embed, un field par responsable, tâches en liens [issueKey](url)', async () => {
    await svc().sendJiraTasksDigest([
      { issueKey: 'FIX-1', titre: 'A', responsable: 'alice@x', url: 'u1', echeance: new Date('2026-06-30') },
      { issueKey: 'FIX-2', titre: 'B', responsable: 'alice@x', url: 'u2', echeance: new Date('2026-06-30') },
      { issueKey: 'FIX-3', titre: 'C', responsable: 'bob@x', url: 'u3', echeance: new Date('2026-06-30') },
    ]);

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body] = (axios.post as jest.Mock).mock.calls[0];
    expect(url).toBe('https://discord.test/webhook');

    const embed = body.embeds[0];
    expect(body.embeds).toHaveLength(1); // UNE notif
    expect(embed.fields).toHaveLength(2); // alice + bob

    const alice = embed.fields.find((f: any) => f.name.includes('alice@x'));
    expect(alice.value).toContain('[FIX-1](u1)');
    expect(alice.value).toContain('[FIX-2](u2)');
    const bob = embed.fields.find((f: any) => f.name.includes('bob@x'));
    expect(bob.value).toContain('[FIX-3](u3)');
  });

  it('responsable absent → section "Non assigné"', async () => {
    await svc().sendJiraTasksDigest([
      { issueKey: 'FIX-9', titre: 'X', responsable: null, url: 'u9' },
    ]);
    const embed = (axios.post as jest.Mock).mock.calls[0][1].embeds[0];
    expect(embed.fields[0].name).toContain('Non assigné');
  });

  it('throw si aucun webhook configuré (pour que l’appelant revert)', async () => {
    delete process.env.DISCORD_APP_ALERT_WEBHOOK;
    await expect(
      svc().sendJiraTasksDigest([{ issueKey: 'X', url: 'u' }]),
    ).rejects.toThrow(/not configured/);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

// AppCronService transitively imports DiService → nanoid (ESM-only) blows up
// under jest unless mocked. Same guard as the DI specs.
jest.mock('nanoid', () => ({ nanoid: () => 'rand' }));

import { AppCronService } from './cron.service';

/**
 * TEST_DISCORD_CHANNELS action — posts a self-identifying test embed to each of
 * the active env's 5 Discord channels. Discord service mocked (no HTTP).
 *  - dev / preprod → 5 sends, each with the right webhook + channel + env
 *  - production    → PROD GUARD: no send
 *  - one channel fails → others still sent, failure counted, exit code ≠ 0
 *  - missing webhook var → that channel is a failure, others OK
 */

const CHANNELS: Array<[string, string]> = [
  ['general-atelier', 'DISCORD_GENERAL_ATELIER_WEBHOOK'],
  ['demande-pdf', 'DISCORD_DEMANDE_PDF_WEBHOOK'],
  ['service-technique', 'DISCORD_SERVICE_TECHNIQUE_WEBHOOK'],
  ['error', 'DISCORD_ERROR_WEBHOOK'],
  ['app-alert', 'DISCORD_APP_ALERT_WEBHOOK'],
];

describe('AppCronService — TEST_DISCORD_CHANNELS', () => {
  const ENV_BACKUP = { ...process.env };
  let discord: { sendTestEmbed: jest.Mock };
  let svc: AppCronService;

  beforeEach(() => {
    for (const [name, envVar] of CHANNELS) {
      process.env[envVar] = `https://discord/${name}`;
    }
    discord = { sendTestEmbed: jest.fn().mockResolvedValue(undefined) };
    svc = new AppCronService(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      discord as any,
      // DiArchiveDigestService — not used in TEST_DISCORD_CHANNELS specs.
      {} as any,
    );
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ENV_BACKUP };
    process.exitCode = 0; // never leak a failing exit into the jest run
    jest.restoreAllMocks();
  });

  it('dev → sends a test embed to the 5 channels with the right webhook + env', async () => {
    process.env.NODE_ENV = 'development';
    const res = await svc.triggerTestDiscordChannels();
    expect(res).toEqual({ skipped: false, total: 5, ok: 5, failed: 0 });
    expect(discord.sendTestEmbed).toHaveBeenCalledTimes(5);
    for (const [name] of CHANNELS) {
      expect(discord.sendTestEmbed).toHaveBeenCalledWith(
        `https://discord/${name}`,
        name,
        'development',
      );
    }
  });

  it('preprod → same 5 sends, env = preprod', async () => {
    process.env.NODE_ENV = 'preprod';
    const res = await svc.triggerTestDiscordChannels();
    expect(res.ok).toBe(5);
    expect(discord.sendTestEmbed).toHaveBeenCalledWith(
      'https://discord/error',
      'error',
      'preprod',
    );
  });

  it('production → PROD GUARD: NO send, skipped', async () => {
    process.env.NODE_ENV = 'production';
    const res = await svc.triggerTestDiscordChannels();
    expect(res).toEqual({ skipped: true, total: 0, ok: 0, failed: 0 });
    expect(discord.sendTestEmbed).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('one channel fails → the others are still sent, failure counted, exit code ≠ 0', async () => {
    process.env.NODE_ENV = 'development';
    discord.sendTestEmbed.mockImplementation((url: string) =>
      url.includes('service-technique')
        ? Promise.reject(new Error('403 webhook révoqué'))
        : Promise.resolve(),
    );
    const res = await svc.triggerTestDiscordChannels();
    expect(res).toEqual({ skipped: false, total: 5, ok: 4, failed: 1 });
    expect(discord.sendTestEmbed).toHaveBeenCalledTimes(5); // all attempted
    expect(process.exitCode).toBe(1);
  });

  it('missing webhook env var → that channel fails (config check), others OK', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DISCORD_ERROR_WEBHOOK;
    const res = await svc.triggerTestDiscordChannels();
    expect(res.ok).toBe(4);
    expect(res.failed).toBe(1);
    expect(discord.sendTestEmbed).toHaveBeenCalledTimes(4); // the missing one is never posted
    expect(process.exitCode).toBe(1);
  });
});

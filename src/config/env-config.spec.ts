import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { envFileName, resolveEnvFilePath } from './environments';
import {
  extractDbName,
  buildStartupBanner,
  buildActionBanner,
} from './env-banner';

/**
 * Multi-environment CLI + banner.
 *  - env → `.env.<env>` resolution (fixture cwd; no real files touched)
 *  - missing file → clear error (no silent fallback)
 *  - unknown CLI arg → non-zero exit, no start
 *  - banner shows env/file/db/port and NEVER a secret
 */

describe('environments — env → .env.<env> resolution', () => {
  it('maps every nodeEnv to its `.env.<env>` file', () => {
    expect(envFileName('development')).toBe('.env.development');
    expect(envFileName('preprod')).toBe('.env.preprod');
    expect(envFileName('production')).toBe('.env.production');
  });

  it('resolves an EXISTING env file from a fixture cwd', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-env-'));
    fs.writeFileSync(path.join(dir, '.env.development'), 'X=1\n');
    fs.writeFileSync(path.join(dir, '.env.production'), 'X=2\n');
    expect(resolveEnvFilePath('development', dir)).toBe(
      path.resolve(dir, '.env.development'),
    );
    expect(resolveEnvFilePath('production', dir)).toBe(
      path.resolve(dir, '.env.production'),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws a CLEAR error (no silent fallback) when the file is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-env-'));
    fs.writeFileSync(path.join(dir, '.env.development'), 'X=1\n'); // preprod absent
    expect(() => resolveEnvFilePath('preprod', dir)).toThrow(
      /\.env\.preprod introuvable/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('banner — DB name extraction never leaks credentials', () => {
  it('returns only the db name from a credentialed SRV URI', () => {
    const uri =
      'mongodb+srv://admin:S3cr3tP%40ss@cluster0.abcd.mongodb.net/fixtronix?retryWrites=true';
    expect(extractDbName(uri)).toBe('fixtronix');
    expect(extractDbName(uri)).not.toContain('S3cr3t');
  });
  it('handles a plain local URI', () => {
    expect(extractDbName('mongodb://localhost:27017/fixtronix')).toBe(
      'fixtronix',
    );
  });
  it('falls back to a placeholder when absent', () => {
    expect(extractDbName(undefined)).toBe('—');
  });
});

describe('banner — startup box', () => {
  it('shows the DEVELOPMENT env + loaded file, and NO secret', () => {
    const uri = 'mongodb://admin:TopSecretPwd@127.0.0.1:27017/fixtronix';
    const banner = buildStartupBanner({
      nodeEnv: 'development',
      port: 3000,
      mongoUri: uri,
    });
    expect(banner).toContain('ENVIRONNEMENT : DEVELOPMENT');
    expect(banner).toContain('.env.development');
    expect(banner).toContain('DB : fixtronix');
    expect(banner).toContain('Port : 3000');
    // The password / raw URI must NEVER appear.
    expect(banner).not.toContain('TopSecretPwd');
    expect(banner).not.toContain(uri);
  });

  it('colors prod RED (ANSI 31) and dev GREEN (ANSI 32)', () => {
    expect(
      buildStartupBanner({ nodeEnv: 'production', port: 3000 }),
    ).toContain('\x1b[31m');
    expect(
      buildStartupBanner({ nodeEnv: 'development', port: 3000 }),
    ).toContain('\x1b[32m');
  });

  it('ACTION banner is a single env-tagged line', () => {
    const line = buildActionBanner('production', 'SYNC_JIRA_DUE_SOON');
    expect(line).toContain(
      '[FIXTRONIX][PRODUCTION] ACTION: SYNC_JIRA_DUE_SOON',
    );
    expect(line).not.toContain('\n');
  });
});

describe('bin/fixtronix.js — CLI argument validation', () => {
  const bin = path.resolve(__dirname, '../../bin/fixtronix.js');

  it('rejects an UNKNOWN environment with a non-zero exit + the valid list', () => {
    const res = spawnSync('node', [bin, 'staging'], { encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/inconnu/i);
    expect(res.stderr).toMatch(/dev.*preprod.*prod/s);
  });

  it('rejects a MISSING environment argument (no start)', () => {
    const res = spawnSync('node', [bin], { encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/manquant/i);
  });
});

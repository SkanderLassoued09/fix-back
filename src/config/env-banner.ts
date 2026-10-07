import { describeEnv, envFileName, EnvColor } from './environments';
import { withErrorContext, reportCatchError } from '../common/error-context';

/** ANSI color per environment (zero-dependency; no chalk). */
const ANSI: Record<EnvColor, string> = {
  green: '\x1b[32m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
};
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Extract ONLY the database name from a Mongo URI — NEVER the credentials.
 *   mongodb+srv://admin:S3cret@cluster/fixtronix?opts  →  'fixtronix'
 *   mongodb://localhost:27017/fixtronix                →  'fixtronix'
 * Falls back to '—' when absent/unparseable.
 */
export function extractDbName(uri?: string): string {
  try {
    if (!uri) return '—';
    try {
      const afterScheme = uri.replace(/^[a-z][a-z+.-]*:\/\//i, '');
      const pathPart = afterScheme.split('/').slice(1).join('/'); // drop host[:port]
      const db = (pathPart.split('?')[0] || '').trim();
      return db || '—';
    } catch (caughtError) {
      reportCatchError(caughtError, 'extractDbName');
      return '—';
    }
  } catch (error) {
    throw withErrorContext(error, 'extractDbName');
  }
}

export interface BannerMeta {
  nodeEnv: string;
  port: string | number;
  /** Full Mongo URI — used ONLY to derive the db name; never printed raw. */
  mongoUri?: string;
}

/**
 * Colored startup box. Contains ONLY: env label, loaded file, DB name, port.
 * NEVER a secret (the db name is extracted; the raw URI is never included).
 *
 *   ┌──────────────────────────────────────────┐
 *   │ FIXTRONIX — ENVIRONNEMENT : PRODUCTION    │
 *   │ Fichier chargé : .env.production          │
 *   │ DB : fixtronix                            │
 *   │ Port : 3000                               │
 *   └──────────────────────────────────────────┘
 */
export function buildStartupBanner(meta: BannerMeta): string {
  try {
    const d = describeEnv(meta.nodeEnv);
    const color = ANSI[d.color];
    const lines = [
      `FIXTRONIX — ENVIRONNEMENT : ${d.label}`,
      `Fichier chargé : ${envFileName(meta.nodeEnv)}`,
      `DB : ${extractDbName(meta.mongoUri)}`,
      `Port : ${meta.port}`,
    ];
    const inner = Math.max(...lines.map((l) => l.length)) + 2;
    const top = '┌' + '─'.repeat(inner) + '┐';
    const bottom = '└' + '─'.repeat(inner) + '┘';
    const body = lines
      .map((l) => '│ ' + l + ' '.repeat(inner - l.length - 1) + '│')
      .join('\n');
    return `${color}${BOLD}${top}\n${body}\n${bottom}${RESET}`;
  } catch (error) {
    throw withErrorContext(error, 'buildStartupBanner');
  }
}

/**
 * One-line banner for ACTION (cron) mode so a standalone run also logs its env:
 *   [FIXTRONIX][PRODUCTION] ACTION: SYNC_JIRA_DUE_SOON
 */
export function buildActionBanner(nodeEnv: string, action: string): string {
  try {
    const d = describeEnv(nodeEnv);
    return `${ANSI[d.color]}${BOLD}[FIXTRONIX][${d.label}] ACTION: ${action}${RESET}`;
  } catch (error) {
    throw withErrorContext(error, 'buildActionBanner');
  }
}

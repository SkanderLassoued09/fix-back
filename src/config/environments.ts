import * as fs from 'fs';
import * as path from 'path';

/**
 * Multi-environment configuration — the SINGLE source of truth.
 *
 * Add an environment = ONE entry in `ENVIRONMENTS` below + a matching
 * `.env.<nodeEnv>` file (+ one alias line in `bin/fixtronix.js` for the CLI).
 * Nothing else in the app needs to change: env-file resolution and the startup
 * banner both read from this table.
 */

export type EnvColor = 'green' | 'amber' | 'red';

export interface EnvDescriptor {
  /** Value of `NODE_ENV` and the suffix of `.env.<nodeEnv>`. */
  nodeEnv: string;
  /** Upper-case label shown in the banner. */
  label: string;
  /** Banner color: green=dev, amber=preprod, red=prod (loud "careful, prod"). */
  color: EnvColor;
}

export const ENVIRONMENTS: EnvDescriptor[] = [
  { nodeEnv: 'development', label: 'DEVELOPMENT', color: 'green' },
  { nodeEnv: 'preprod', label: 'PREPROD', color: 'amber' },
  { nodeEnv: 'production', label: 'PRODUCTION', color: 'red' },
];

/** Used when `NODE_ENV` is unset (e.g. a bare `nest start` on a dev machine). */
export const DEFAULT_NODE_ENV = 'development';

/** Descriptor for a `nodeEnv`; unknown values degrade gracefully (amber). */
export function describeEnv(nodeEnv: string): EnvDescriptor {
  return (
    ENVIRONMENTS.find((e) => e.nodeEnv === nodeEnv) ?? {
      nodeEnv,
      label: (nodeEnv || 'UNKNOWN').toUpperCase(),
      color: 'amber',
    }
  );
}

/** `.env.<nodeEnv>` file name (no path). */
export function envFileName(nodeEnv: string): string {
  return `.env.${nodeEnv}`;
}

/**
 * Resolve + assert the target env file exists. Throws a CLEAR error (no silent
 * fallback) when absent. Pure — safe to unit-test with a fixture `cwd`.
 */
export function resolveEnvFilePath(
  nodeEnv: string,
  cwd: string = process.cwd(),
): string {
  const file = envFileName(nodeEnv);
  const full = path.resolve(cwd, file);
  if (!fs.existsSync(full)) {
    throw new Error(
      `Fichier ${file} introuvable (cherché : ${full}). ` +
        `Crée-le, ou lance un autre environnement (dev / preprod / prod).`,
    );
  }
  return full;
}

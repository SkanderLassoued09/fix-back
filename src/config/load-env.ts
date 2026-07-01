import * as dotenv from 'dotenv';
import { DEFAULT_NODE_ENV, resolveEnvFilePath } from './environments';

/**
 * Loads the SINGLE targeted env file `.env.${NODE_ENV}` BEFORE anything reads
 * `process.env`. This REPLACES the old `import 'dotenv/config'` (which loaded a
 * plain `.env`).
 *
 *   - `NODE_ENV` is set by the CLI (`bin/fixtronix.js`); when unset it defaults
 *     to `development` so a bare `nest start` still works on a dev machine.
 *   - Only ONE file is loaded (the targeted one) — a missing file is a clean,
 *     colored fatal error (NO silent fallback).
 *
 * Import for SIDE EFFECT as the very first line of `main.ts`:
 *   `import './config/load-env';`
 */
function loadEnvironment(): { nodeEnv: string; envFilePath: string } {
  const nodeEnv = process.env.NODE_ENV?.trim() || DEFAULT_NODE_ENV;
  process.env.NODE_ENV = nodeEnv; // normalize downstream reads

  try {
    const envFilePath = resolveEnvFilePath(nodeEnv);
    dotenv.config({ path: envFilePath });
    return { nodeEnv, envFilePath };
  } catch (err) {
    // Clean fatal error — the operator just needs the reason, not a stack.
    process.stderr.write(
      `\x1b[31m[FIXTRONIX] ${(err as Error).message}\x1b[0m\n`,
    );
    process.exit(1);
  }
}

/** Resolved at import time (side effect). Handy for the banner / diagnostics. */
export const LOADED_ENV = loadEnvironment();

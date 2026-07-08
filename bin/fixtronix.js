#!/usr/bin/env node
'use strict';

/**
 * Fixtronix multi-environment launcher — cross-platform, ZERO dependency.
 *
 * Usage:
 *   node bin/fixtronix.js dev                         # HTTP server, watch
 *   node bin/fixtronix.js preprod                     # HTTP server (dist)
 *   node bin/fixtronix.js prod                        # HTTP server (dist)
 *   node bin/fixtronix.js prod --action SYNC_GOOGLE_SHEETS   # standalone cron
 *
 * It only SELECTS the environment (sets NODE_ENV) and launches the EXISTING
 * bootstrap (`main.ts`) — it does not re-implement it. NODE_ENV is passed to the
 * child via its env (NOT the Unix `VAR=x` shell prefix, which breaks on Windows
 * CMD). The child's `main.ts` then loads `.env.<NODE_ENV>` and prints the banner.
 */

const { spawn } = require('child_process');

// ── Single mapping table — add an env = ONE entry here + a `.env.<nodeEnv>` file
//    + one entry in `src/config/environments.ts` (banner color/label).
const ENVIRONMENTS = {
  dev: {
    nodeEnv: 'development',
    serve: ['npx', ['nest', 'start', '--watch']],
    action: ['npx', ['ts-node', '-r', 'tsconfig-paths/register', 'src/main.ts']],
  },
  preprod: {
    nodeEnv: 'preprod',
    serve: ['node', ['dist/main']],
    action: ['node', ['dist/main']],
  },
  prod: {
    nodeEnv: 'production',
    serve: ['node', ['dist/main']],
    action: ['node', ['dist/main']],
  },
};

function fail(message) {
  process.stderr.write(`\x1b[31m[FIXTRONIX] ${message}\x1b[0m\n`);
  process.stderr.write(
    `Environnements valides : ${Object.keys(ENVIRONMENTS).join(' | ')}\n`,
  );
  process.stderr.write(
    'Exemples :\n' +
      '  node bin/fixtronix.js dev\n' +
      '  node bin/fixtronix.js prod\n' +
      '  node bin/fixtronix.js prod --action SYNC_GOOGLE_SHEETS\n',
  );
  process.exit(1);
}

const [, , alias, ...rest] = process.argv;
if (!alias) fail('Environnement manquant.');

const cfg = ENVIRONMENTS[alias];
if (!cfg) fail(`Environnement inconnu : "${alias}".`);

// Optional standalone ACTION: `<env> --action NAME` (or `<env> NAME`).
let action = null;
const flagIdx = rest.indexOf('--action');
if (flagIdx !== -1) {
  action = rest[flagIdx + 1];
} else if (rest[0] && !rest[0].startsWith('-')) {
  action = rest[0];
}
if (rest.length && !action) fail("Nom d'action manquant après --action.");

const [cmd, args] = action ? cfg.action : cfg.serve;
const childEnv = { ...process.env, NODE_ENV: cfg.nodeEnv };
if (action) {
  childEnv.ACTION = action;
} else {
  // SERVE mode: DROP any ACTION inherited from the shell. On Windows a
  // `set ACTION=NAME` persists across commands, so a leftover cron name would
  // otherwise hijack `start:dev|preprod|prod` into ACTION mode (no HTTP server).
  // The serve/action choice comes ONLY from the CLI here — to run a cron pass it
  // EXPLICITLY: `node bin/fixtronix.js <env> --action <NAME>` (or `npm run action:*`).
  delete childEnv.ACTION;
}

const child = spawn(cmd, args, {
  stdio: 'inherit',
  env: childEnv,
  // `shell: true` lets the npx/nest/node shims resolve on both Windows and Linux.
  shell: true,
});

child.on('error', (err) => fail(`Échec du lancement : ${err.message}`));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 0 : code);
});

import { defineConfig, devices } from '@playwright/test';

/**
 * Fixtronix ERP — Playwright config.
 *
 * The app is started and managed by the developer (per Phase-2 brief E3):
 *   backend : npm run start:dev      → http://localhost:3000  (GraphQL at /graphql)
 *   frontend: ng serve -o            → http://localhost:4200
 * We deliberately do NOT use `webServer` here so we never auto-start (or risk
 * touching) anything; the harness only ever talks to a stack the dev confirms.
 *
 * GraphQL note: every backend call is POST {apiUrl}graphql and returns HTTP 200
 * even on failure — success is judged by the response `errors`/`data`, handled
 * in utils/graphql.ts, NOT by status code.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/artifacts',

  fullyParallel: false, // DI workflow state is shared server-side; keep deterministic
  workers: 1,
  // The tests are deterministic; retries only absorb the dev backend's brief
  // restart windows (it runs under OneDrive, so `nest --watch` recompiles when
  // sync touches files → transient ECONNREFUSED). Not masking test flakiness.
  retries: 1,
  forbidOnly: !!process.env.CI,

  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/html-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],

  use: {
    baseURL: 'http://localhost:4200',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    // Logs in all 6 roles, asserts success, and persists per-role storageState
    // under qa/.auth/<ROLE>.json for the rest of the suite to reuse.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },

    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
});

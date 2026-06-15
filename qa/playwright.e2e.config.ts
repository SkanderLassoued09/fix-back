import { defineConfig, devices } from '@playwright/test';

/**
 * Company feature e2e (UI + API input-health). Separate from the main suite so
 * it can be run on its own (`npm run e2e` / `npm run e2e:api`).
 *
 * Servers are dev-managed (same convention as playwright.config.ts):
 *   backend : http://localhost:3000  (GraphQL /graphql)   — API_URL overridable
 *   frontend: http://localhost:4200                       — UI_URL overridable
 * We don't use `webServer` so a run never auto-starts (or risks touching) the
 * stack; start `ng serve` + `npm run start:dev` yourself first. The API spec
 * needs only the backend; the UI spec needs both.
 */
export default defineConfig({
    testDir: './e2e',
    outputDir: './test-results/e2e-artifacts',
    fullyParallel: false,
    workers: 1,
    retries: 1,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: [
        ['list'],
        ['html', { outputFolder: 'test-results/e2e-report', open: 'never' }],
    ],
    use: {
        baseURL: process.env.UI_URL ?? 'http://localhost:4200',
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

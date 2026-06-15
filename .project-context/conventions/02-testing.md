# Testing

**Purpose:** Describe how tests are organized and run, and the real state of test coverage.

---

## Backend ([`fix-back/`](../../fix-back/))

- **Runner:** Jest 29 + `ts-jest`. Config is **inline in [`package.json`](../../fix-back/package.json)** (`rootDir: src`, `testRegex: .*\.spec\.ts$`, `moduleNameMapper: { "^src/(.*)$": "<rootDir>/$1" }`, `testEnvironment: node`).
- **Unit tests:** co-located `*.spec.ts` next to source.
- **E2E:** [`test/app.e2e-spec.ts`](../../fix-back/test/app.e2e-spec.ts) + [`test/jest-e2e.json`](../../fix-back/test/jest-e2e.json).

**Commands:**
```bash
npm run test          # unit
npm run test:watch
npm run test:cov      # coverage → ../coverage
npm run test:e2e
```

### Reality of coverage
- **Genuine unit tests exist** for the newer/critical pieces: [`di/workflow/di-workflow.service.spec.ts`](../../fix-back/src/di/workflow/di-workflow.service.spec.ts) mocks the Di model + StatService and exercises real transition logic; `auth`, `audit`, `dashboard-kpi`, `logs-di`, `profile`, `stat`, `discord-hook` have `*.spec.ts` resolver/service tests.
- **No tests** for the core `DiService` (~2,900 lines) — the highest-risk, least-tested code.
- ⚠️ **The e2e test is stale/broken:** it asserts `GET /` → `200 "Hello World!"`, but `AppController` is **not registered** in `app.module.ts` (`controllers: []`), so `/` 404s. The e2e also boots the full `AppModule`, which opens a **real MongoDB connection** (`localhost:27017`) and the cron/schedule providers — it won't pass in CI without Mongo. Treat it as scaffolding, not a working smoke test.

## Frontend ([`fix-front/`](../../fix-front/))

- **Runner:** Karma + Jasmine (config referenced by [`angular.json`](../../fix-front/angular.json); `src/test.ts` is the entry). Run with `npm run test` (`ng test`).
- **Unit tests:** co-located `*.spec.ts`, but **mostly default scaffolds** (e.g. [`ticket.service.spec.ts`](../../fix-front/src/app/demo/service/ticket.service.spec.ts) only asserts the service "should be created"). The component specs (`*.component.spec.ts`) are the Angular CLI defaults.
- `npm run e2e` is wired (`ng e2e`) but no e2e runner/specs are present; a `add-playwright-testing` branch exists, suggesting Playwright is being introduced.

---

## Practical guidance
- When you change the **workflow engine**, update/extend `di-workflow.service.spec.ts` — it's the model to follow.
- Don't rely on `npm run test:e2e` as a gate until the controller registration and Mongo dependency are fixed (logged in [decisions/02-open-questions.md](../decisions/02-open-questions.md)).
- There is **no CI** configured in-repo (no `.github/workflows`, CircleCI, etc. — the README badges are NestJS's own, not this project's). Tests are run manually.

---

## Related files
- [`fix-back/package.json`](../../fix-back/package.json) (jest block), [`fix-back/test/`](../../fix-back/test/)
- [03-git-workflow.md](03-git-workflow.md)

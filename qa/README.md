# Fixtronix ERP — QA Harness (Playwright)

Standalone Playwright harness. **Intentionally outside** the `fix-front` and
`fix-back` git repos (its own `node_modules`, per brief E7).

## Prerequisites
The dev runs the stack; this harness never starts it:
- Backend: `cd fix-back && npm run start:dev` → http://localhost:3000 (GraphQL `/graphql`)
- Frontend: `cd fix-front && ng serve -o` → http://localhost:4200

## Install (one-time)
```powershell
cd qa
npm install
npx playwright install chromium
```

## Run
```powershell
npm run verify:auth   # log in all 6 roles, assert success, save sessions  (Phase 2 gate)
npm test              # full suite (runs `setup` first, then chromium)
npm run report        # open the last HTML report
npm run list          # list discovered tests without running (no app needed)
```

## Layout
```
qa/
├── playwright.config.ts     # baseURL :4200, single chromium project, no webServer
├── utils/
│   ├── roles.ts             # the 6 seeded accounts (+ COORDIANTOR misspelling note)
│   ├── auth.ts              # loginViaUI(), authFile(), LoginResult
│   └── graphql.ts           # GqlRecorder + assertNoGqlErrors/assertNoDuplicateMutations
├── fixtures/
│   └── auth.ts              # extended `test` with auto-attached `gql` recorder
├── tests/
│   ├── auth.setup.ts        # `setup` project: verify logins + persist .auth/<ROLE>.json
│   ├── exploratory/         # Phase-3 exploratory specs (01-auth … 07-dashboard)
│   └── regression/          # Phase-4 deterministic regression suite
├── .auth/                   # generated per-role storageState (git-ignored)
└── test-results/            # reports, traces, screenshots, videos (git-ignored)
```

## Conventions
- **GraphQL-aware:** every backend call is HTTP 200 even on failure. Judge by
  `response.errors`/`data` via `GqlRecorder`, never the status code.
- **No `waitForTimeout`:** use Playwright web-first assertions + auto-waiting.
- **Role sessions:** reuse a login in a spec with
  `test.use({ storageState: authFile('MANAGER') })`.
- **Stateful DI tests** create their own DI and drive only that one; concurrent /
  multi-tab tests are tagged `@flaky` and isolated.

See `../TESTING_STRATEGY.md` for the full plan and `./QA_REPORT.md` for findings.

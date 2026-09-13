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

## Jeu de scénarios DI (seed manuel)

`scripts/seed-scenarios.mjs` pose **une DI par scénario de diagnostic** (flux
original ET retour) et **une DI par poste de travail** en aval — magasin, poignée
de main composants, tarification, approbation documentaire, réparation, clôture —
puis **prouve le routage** en tirant les vraies mutations GraphQL avant de
reseeder un jeu propre. Il remplace les anciens `seed-flow-test.js` et
`seed-retour-combos.mjs`.

```bash
npm run seed          # purge → vérifie le routage → seed → plan de test par écran
npm run seed:clean    # purge seule
npm run seed:only     # seed sans vérification (backend :3000 éteint)
node scripts/seed-scenarios.mjs --only=A,C   # limite à certains groupes
```

41 DI, toutes préfixées `DI_scn_`, référencées `SC-<groupe><n>` :

| Groupe | Contenu | Écran · compte |
|---|---|---|
| A (15) | entrée diagnostic : réparable × PDR × payant × cycle × source de l'erreur | `tech-di-list` · `tech` |
| B (4)  | amont : CREATED, PENDING1, DIAGNOSTIC, DIAGNOSTIC_Pause | `ticket-list` / `coordinator-di-list` |
| C (6)  | sortie magasin (dont le détour Fixtronix) + poignée de main en 3 temps | `magasin-di-list` · `houda` |
| D (7)  | tarification payant / non payant, WAITING_DEVIS, WAITING_BC, NEGOTIATION2 | `ticket-list` · `skander` |
| E (7)  | PENDING3, réparation, WAITING_BL, WAITING_FACTURE, FINISHED | `coordinator-di-list` / `tech-di-list` |
| F (2)  | IRREPARABLE, ANNULER | `ticket-list` · `skander` |

Chaque DI porte son **scénario dans `title`** et les **étapes attendues dans
`description`** : le testeur sait quoi cliquer sans quitter l'écran.

**À savoir**
- Le script écrit dans `fixtronixproddb`, la base que l'app lit réellement (aucune
  base de test isolée n'existe). Seul le préfixe `DI_scn_` est touché.
- Une DI seedée, c'est **trois** documents : `dis`, `stats` (c'est `Stat.status`
  que la liste technicien filtre, pas `Di.status`) et `logsdis` (le dossier du
  cycle, une ligne par cycle).
- Cinq cas restent en ✋ *test manuel* : ils exigent un geste humain (saisie du
  verdict par le technicien) ou un vrai téléversement Drive — ils sont **amorcés**,
  jamais comptés en échec.
- Les comptes sont résolus **par rôle** à l'exécution : la coordinatrice est
  `Rachida` et le magasin `houda` (`utils/roles.ts` annonce encore `coordinateur`
  et `magasin`, qui n'existent pas en base).

## Conventions
- **GraphQL-aware:** every backend call is HTTP 200 even on failure. Judge by
  `response.errors`/`data` via `GqlRecorder`, never the status code.
- **No `waitForTimeout`:** use Playwright web-first assertions + auto-waiting.
- **Role sessions:** reuse a login in a spec with
  `test.use({ storageState: authFile('MANAGER') })`.
- **Stateful DI tests** create their own DI and drive only that one; concurrent /
  multi-tab tests are tagged `@flaky` and isolated.

See `../TESTING_STRATEGY.md` for the full plan and `./QA_REPORT.md` for findings.

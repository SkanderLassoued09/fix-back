# Fixtronix ERP — QA Report

**Environment under test:** frontend `http://localhost:4200`, backend `http://localhost:3000/graphql`, local seeded throwaway DB.
**Harness:** `qa/` (Playwright). **Strategy:** `../TESTING_STRATEGY.md`.
**Last updated:** 2026-06-10

> Living document. Phase 3 (exploratory) findings and Phase 4 (regression) coverage are appended as work proceeds.

---

## Fixes applied — Réparation modal pause/resume (2026-06-10)

Closes the repair-modal portion of deferred Area 7. Goal: instant status propagation on pause/resume, matching the Diagnostic modal. **Diagnostic left untouched; the finish path left untouched.**

**Two root causes found & fixed** (both in `fix-front/.../tech-di-list/tech-di-list.component.ts`):

1. **Pause didn't propagate (timing).** `lapTimeForPauseAndGetBack1` chained the status→`REPARATION_Pause` mutation *inside* the lap mutation's response (2nd roundtrip), so the 350 ms-debounced list refresh read stale `INREPARATION` and reverted the chip. **Fix:** fire the status mutation **directly/in parallel** for the pause case — mirroring the diagnostic flow's `diDiagnostiqueInPAUSE`. (The backend already broadcasts the change over WS with the Stat's tech ids via `broadcastDiStatusChange`, so the stale comment claiming otherwise was corrected.)
2. **Resume never fired + header pill stuck.** `repModal()` set `this.di = {…di}` and then immediately called `resetModalForm()`, which **nulls `this.di`**. So `onRepairModalPause` ran with `this.di = null` → `currentStatus = ''` → every header click took the *pause* branch (Reprendre never resumed) and the optimistic `if (this.di)` UI update was skipped (pill stuck at "REPARATION"). The diagnostic flow is immune (it branches on `diStatus`, not `this.di`). **Fix:** assign `this.di` **after** `resetModalForm()` in `repModal`.

**Also:** fixed the stale comment at the former `:3263` (WS payload *does* carry tech ids). Logged **B7** in `.project-context/decisions/01-known-issues.md` (`generateClientId` ignores `isDeleted` / non-conforming `_idnum` → counter re-poisoning). **Data cleanup:** hard-deleted the polluted `TEST01` `dis` + `stats` rows (counter back to `DI41`).

**Verified** (`tests/regression/04-repair-modal.regression.spec.ts`, green, no retry): opening the real repair modal and clicking **Mettre en pause** flips the DI to `REPARATION_Pause` on the backend, on a **second open TECH view without reload**, and on the modal pill; **Reprendre** flips it back to `INREPARATION` everywhere; **no GraphQL errors, no page errors, no `_idnum`/stat errors**.

---

## Fixes applied — Réparation timer survives refresh (2026-06-10)

**Bug:** the repair-modal timer reset to `00:00:00` on page refresh — time already spent in réparation was lost because the displayed elapsed was an in-memory counter, not derived from persisted data. **Réparation only; Diagnostic untouched (read as reference). No localStorage/sessionStorage for the timer — persistence is server-side so it is correct across refresh, tabs, and devices.**

**Server-anchored timer model** (mirrors the diagnostic wiring): `elapsed = rep_time + (INREPARATION ? now − repRunStartedAt : 0)`, frozen at `rep_time` while `REPARATION_Pause`.

**Backend** (user-approved schema change):
- **`Stat.repRunStartedAt: Date`** added (`fix-back/src/stat/entities/stat.entity.ts`, schema `@Prop` + GraphQL `@Field({nullable:true})`).
- Stamped in **`di.service.ts → changeStatusInRepair`** only when **`previousStatus !== INREPARATION`** (a true start/resume) — never on the open no-op or on pause — so a refresh while running keeps the original run-leg start instead of re-anchoring to "now".
- Exposed `repRunStartedAt` (+ `status`, `rep_time`) in the tech-list GraphQL selections (`fix-front/.../ticket.service.ts`: `searchTechDI`, `getDiForTech`).

**Frontend** (`fix-front/.../tech-di-list/tech-di-list.component.ts` host + `tech-repair-list` modal):
- `repModal()` seeds the modal's server-anchored inputs from the row's persisted data: paused → frozen at `rep_time` (no anchor); running → use persisted `repRunStartedAt` (survives refresh); fresh start → anchor "now".
- The modal ticks live from `elapsedBaseMs + (now − runStartedAtMs)` while running and is frozen while paused — no in-memory counter.

**Second root cause found during verification (the actual "reset" on a paused refresh):** the **pause branch of `onRepairModalPause` never persisted the dialog snapshot** (only resume did), so on refresh `restoreDialogState()` replayed the stale `INREPARATION` snapshot and `repModal()` **auto-resumed** the paused DI (`changeStatusInReparation`). Fixed by persisting the snapshot in its **paused form** (status `REPARATION_Pause` + the frozen `rep_time` carried onto `this.di`) on pause. Also fixed a latent **resume→refresh double-count**: resume now mirrors the new `repRunStartedAt` anchor onto `this.di` so the restored snapshot doesn't keep the pre-pause anchor.

**Cleanup:** removed the leftover `[REPAIR][HOST]`/`[onRepairModalPause]` debug `console.log` scaffolding from the handler (kept the genuine ABORT error log).

**Verified** (`tests/regression/04-repair-modal.regression.spec.ts` → new test *"Réparation timer survives reload…"*, green): with a Stat staged at a known **5-minute** run leg —
- **run → refresh → continues** (modal shows ~5 min, not 0; survives reload);
- **pause → refresh → frozen** (stays at the same value across reload, does **not** auto-resume);
- **resume → continues** (button flips `Reprendre`→`Mettre en pause`, timer resumes from the accumulated value).

No GraphQL errors, no uncaught page errors.

---

## Phase 2 — Harness status

| Item | Status |
|------|--------|
| Playwright installed (`@playwright/test` 1.60.0 + Chromium) in `qa/`, outside both git repos | ✅ done |
| `playwright.config.ts` (baseURL :4200, single chromium project, GraphQL-aware, no `webServer`) | ✅ done |
| Per-role auth fixture + storageState bootstrap (`tests/auth.setup.ts`) | ✅ written |
| GraphQL-capture helper (`utils/graphql.ts`) | ✅ written |
| Harness compiles & tests discovered (`playwright test --list` → 6 tests) | ✅ verified |
| App reachable + all 6 logins verified live | ✅ **PASS** (6/6, 8.7s) |

**Live verification result** (`npm run verify:auth`, 2026-06-10): all 6 roles
logged in via the real UI, no GraphQL `errors`, token persisted, redirected off
`/auth/login`, and the stored role matched the documented value for every role:

| Account | Stored role | Token |
|---------|-------------|-------|
| skander | `ADMIN_MANAGER` | ok |
| admin_tech | `ADMIN_TECH` | ok |
| manager | `MANAGER` | ok |
| coo | `COORDIANTOR` *(intentional misspelling — matched)* | ok |
| tech | `TECH` | ok |
| magasin | `MAGASIN` | ok |

Per-role `storageState` saved to `qa/.auth/<ROLE>.json` (localStorage keys
`token, role, username, _id`) for reuse by later phases. **Phase 2 complete.**

---

## Test data created during QA
_(Per brief E6 — log anything created via the app's UI/API to make a path testable.)_

| Date | Role used | What was created | Why | Cleanup |
|------|-----------|------------------|-----|---------|
| 2026-06-10 | ADMIN_MANAGER | Test clients (`first_name` = `QA<ts>` / `QADUP<ts>`, region TUNIS) | A3.1/A3.4 create+CRUD tests | ✅ deleted (soft) by the tests themselves |
| 2026-06-10 | ADMIN_MANAGER | Test DIs (`title` = `QA-DI-*`) attached to an existing seed client | A5/H1/H2 workflow tests | ✅ soft-deleted (`deleteDi`) by each test |

---

## Phase 3 & 4 — Summary

**Exploratory:** Areas 1–6, 8, 9 fully covered (35 exploratory tests). Areas 7, 10, 11 deferred to backlog with rationale (complex modal orchestration / event-timing / inherent flakiness).

**Full-suite run:** 50 tests → **48 passed**; the 2 failures were transient **backend-flap** connection errors in Area 6 (the backend cycles under OneDrive-triggered `--watch` restarts), not test/app defects — each area passes in isolation and `retries: 1` now absorbs the restart windows.

**Regression suite** (`tests/regression/`, 10 tests, deterministic & self-cleaning) — run with `npx playwright test tests/regression`:
| Spec | Covers |
|------|--------|
| `01-auth.regression.spec.ts` | All 6 roles log in via UI with the documented role; wrong password rejected |
| `02-di-lifecycle.regression.spec.ts` | DI `create → CREATED → PENDING1` (validated transitions) + soft-delete cleanup |
| `03-client-crud.regression.spec.ts` | Client `create → searchable → soft-delete → no longer searchable` |
| `04-repair-modal.regression.spec.ts` | Repair modal **pause→propagate** & **resume→propagate** verified on a 2nd open view (no reload) + backend + modal pill; **+ server-anchored timer survives refresh** (run→refresh→continues, pause→refresh→frozen, resume→continues); no errors |

**Findings tally:** 13 logged — **1 High (F4 auth bypass / S12)**, 3 Major (F10 invalid transitions, F11 wrong-role transitions, F13 public document serving / S7), the rest Minor/confirmed-gap. Plus a documented **environment issue** (backend flapping under OneDrive).

**Areas covered vs skipped:**
| Area | Status | Why |
|------|--------|-----|
| 1 Auth, 2 Nav/permissions, 3 CRUD, 4/5 DI workflow, 6 Search, 8 Uploads, 9 Dashboard | ✅ covered | — |
| 7 Modals (diagnostic/repair steppers) | ⏸ deferred | needs orchestrated DI state + multi-step timer modals; the transitions they fire are covered at the API layer (Area 5) |
| 10 Notifications / real-time | ⏸ deferred | Socket.io push timing is non-deterministic; needs a two-context harness |
| 11 Resilience | ◑ partial | reload (A1.8) + double-click (A3.4) done; refresh-mid-request / multi-tab deferred (inherently flaky) |

---

## Coverage log

| Area | Status | Tests | File |
|------|--------|-------|------|
| 1 — Auth & session | ✅ done | 9 passed | `tests/exploratory/01-auth.spec.ts` |
| 2 — Navigation, menu & permission gap | ✅ done | 12 passed | `tests/exploratory/02-navigation-permissions.spec.ts` |
| 3 — Reference CRUD (Clients, representative) | ✅ done | 4 passed | `tests/exploratory/03-reference-crud.spec.ts` |
| 4 + 5 — DI create & workflow (API-driven) | ✅ done | 4 passed | `tests/exploratory/04-di-workflow.spec.ts` |
| 6 — Search / filter / pagination | ✅ done | 3 passed | `tests/exploratory/05-search-filter.spec.ts` |
| 8 — File uploads | ✅ done | 1 passed | `tests/exploratory/06-file-upload.spec.ts` |
| 9 — Dashboard KPIs & consistency (H3) | ✅ done | 2 passed | `tests/exploratory/07-dashboard.spec.ts` |
| 7 — Modals (diagnostic/repair steppers) | ⏸ deferred → backlog | — | complex orchestration; rationale in backlog |
| 10 — Notifications / real-time | ⏸ deferred → backlog | — | event-timing; rationale in backlog |
| 11 — Resilience | ◑ partial (A1.8 reload, A3.4 double-click) | — | remainder in backlog |

> **⚠️ Environment note (2026-06-10) — backend flapping:** Midway through Area 6 the backend (`:3000`) cycled down and back up (port stopped/started listening; a new backend PID appeared). Most likely cause: the repo lives under **OneDrive**, whose background sync touches files and makes `nest start --watch` recompile/restart. While it was down, `findAllClient` calls failed and the client list rendered empty ("Aucun client trouvé") — a **false alarm, not a bug** (confirmed: with the backend up, `findAllClient.total = 8`). Area 6 was made **self-seeding** (creates its own client via API) and re-run green. The flapping can still cause spurious failures on any live run; re-run a failed test before trusting it.

---

## Bugs / findings

### [Minor] F1 — Special characters in username silently break login (confirms S10)
- **Severity:** Minor (UX + confirms injection-class flaw at the auth surface)
- **Area:** auth · **Roles:** all (login screen)
- **Description:** Typing a GraphQL-breaking character (e.g. a double-quote `"`) in the username makes the **Sign In button appear to do nothing** — no error message, no toast, no navigation. No network request is sent.
- **Repro:** `/auth/login` → username = `evil" injected`, password = anything → click **Sign In**.
- **Expected vs actual:** Expected an "invalid credentials"/validation message. Actual: total silent failure; only a JavaScript error in the console.
- **Root cause:** `profile.service.getTokenLogin()` builds the login mutation by **interpolating the raw username into a `gql\`\`` template** (`username: "${username}"`). The `gql` tag parses the document **client-side** and throws a SyntaxError on the unescaped quote, before Apollo sends anything. (Known-issue **S10** — raw GraphQL string interpolation.)
- **Evidence:** `tests/exploratory/01-auth.spec.ts` A1.5 (+ attached `A1.5-client-errors.txt`); no `login` request observed.
- **Suggested fix:** Use parameterized variables: `mutation Login($u:String!,$p:String!){ login(loginAuthInput:{username:$u,password:$p}){...} }`. Apply the same fix across services (S10 is project-wide).
- **Confirms documented issue?** Yes — S10.

### [Minor] F2 — No client-side validation on login; empty form submits literal `"null"`
- **Severity:** Minor
- **Area:** auth · **Roles:** all (login screen)
- **Description:** Clicking **Sign In** with both fields empty sends `login(loginAuthInput: { username: "null", password: "null" })` — the literal string `null`.
- **Repro:** `/auth/login` → click **Sign In** without typing anything.
- **Expected vs actual:** Expected the submit to be disabled / a "required" message. Actual: a doomed request for a user named `"null"` is sent (backend then returns a GraphQL error).
- **Root cause:** `loginForm` controls default to `null`; `login()` interpolates `${username}` → `"null"`; no `Validators.required`, button not disabled on invalid form.
- **Evidence:** A1.4 (asserts the sent query contains `username: "null"` and the response has `errors[]`).
- **Suggested fix:** Add `Validators.required`, disable the button while the form is invalid, and parameterize the query (see F1).
- **Confirms documented issue?** Partially related to S10.

### [Info — confirmed gap] F3 — Client route guard validates token *presence* only (confirms S9)
- **Severity:** Info (confirms documented gap, not a new bug)
- **Area:** auth/permissions · **Roles:** all
- **Description:** Placing **any** non-empty string in `localStorage.token` grants access to protected routes; the guard never validates the token.
- **Repro:** Without logging in, set `localStorage.token = 'garbage.tampered.token'` → navigate to `/tickets/ticket/ticket-list` → not redirected to login.
- **Root cause:** `authGuard` → `ProfileService.checkAuth()` returns `true` whenever a token string exists. (Known-issue **S9**.)
- **Evidence:** A1.7 (passes — i.e. access granted with a bogus token).
- **Note:** Real authorization must be enforced server-side; UI access ≠ data access. The genuine gate is whether the **backend** honors a forged token — tested in Area 2 (permission gap) and Area 5.
- **Confirms documented issue?** Yes — S9.

### [High] F4 — `JwtAuthGuard` does not enforce authentication (auth bypass on the "guarded" mutations)
- **Severity:** High (Critical if the API is reachable beyond a trusted LAN)
- **Area:** permissions/auth (backend) · **Roles:** n/a (anonymous)
- **Description:** The four mutations decorated `@UseGuards(JwtAuthGuard)` (`createDi`, `confirmDiComponents`, `sendDiToAdminsForPricing`, `componentConfirmedFromCoordinator`) execute for callers **with no token at all**. An anonymous `confirmDiComponents(diId:"0000…")` returns a domain **404 "DI … not found"** (the resolver/service ran) instead of "Unauthorized".
- **Repro:** `POST http://localhost:3000/graphql` with **no `Authorization` header**, body `mutation { confirmDiComponents(diId:"000000000000000000000000"){ _id } }` → HTTP 200 with a *not-found* error, not an auth error.
- **Expected vs actual:** Expected `Unauthorized`. Actual: the guard lets the request through and the resolver executes unauthenticated.
- **Root cause:** [`fix-back/src/auth/jwt-auth-guard.ts`](../fix-back/src/auth/jwt-auth-guard.ts) overrides Passport's `handleRequest` as `if (user) return user;` with **no `else throw`**. Returning `undefined` (instead of throwing) makes `canActivate` resolve truthy, so unauthenticated/invalid-token requests pass through with `req.user = undefined`.
- **Evidence:** A2 test "FINDING: JwtAuthGuard does NOT block anonymous calls" (+ attached `A2-authguard-bypass.json`).
- **Suggested fix:** `handleRequest(err, user) { if (err || !user) throw err || new UnauthorizedException(); return user; }`. Then add real authorization (a working role guard) on state-changing mutations.
- **Confirms documented issue?** Extends/worsens **S3** — the *few* mutations that looked protected are not. Combined with S3 (most resolvers unguarded), the **entire mutation surface is effectively unauthenticated**.

### [Minor] F5 — GraphQL error responses leak server stack traces and absolute file paths
- **Severity:** Minor (information disclosure)
- **Area:** backend · **Roles:** anyone who can reach the API
- **Description:** Error responses include `extensions.stacktrace` with full Node stack frames and **absolute filesystem paths** (e.g. `c:\Users\meher\…\fix-back\src\di\di.service.ts:2870`), plus `originalError`.
- **Evidence:** the `A2-authguard-bypass.json` attachment from F4.
- **Suggested fix:** Disable stacktraces in production (Apollo `includeStacktraceInErrorResponses: false` / format errors); also relates to **S6** (Playground/introspection on in prod).
- **Confirms documented issue?** Related to S6.

### [Info — confirmed gap] F6 — No role-based route guard; low-privilege roles can deep-link into admin views (S3/S4)
- **Severity:** Info (confirms documented gap)
- **Area:** navigation/permissions (frontend)
- **Description:** A `TECH` session can navigate directly to `/profiles/profile/profile-list` and `/tickets/ticket/ticket-list` (admin/manager screens) — the pages load; only the menu hides them.
- **Evidence:** A2 "deep-link bypass" test (passes → routes load for TECH).
- **Confirms documented issue?** Yes — S3/S4.

### [Info — confirmed gap] F7 — Backend does not gate reads by role (S3/S4)
- **Severity:** Info (confirms documented gap)
- **Description:** A `TECH` token successfully reads `getAllProfiles` (the staff list the UI restricts to admins/managers) via the API.
- **Evidence:** A2 "TECH token can read the staff list" test.
- **Confirms documented issue?** Yes — S3/S4.

### [Minor] F8 — Dashboard route loads for every role, including those whose menu hides/omits it
- **Severity:** Minor (the Phase-3 item you flagged)
- **Area:** navigation (frontend)
- **Description:** After login the app always routes to `/`. `TECH`/`MANAGER` show a dead "Statistique" menu label (no `routerLink`) and `COORDIANTOR`/`MAGASIN` have no dashboard item at all, yet all of them can sit on the full dashboard at `/`. The page **loads without an uncaught error** for these roles (no crash observed); whether they *should* see KPI data is a product question.
- **Evidence:** A2 "dashboard-route mismatch" tests for TECH/COORDINATOR/MAGASIN (pass; `pageErrors` empty). Per-role KPI-data correctness deferred to Area 9.
- **Confirms documented issue?** Yes — the documented post-login/menu mismatch.

### [Minor] F9 — Special characters silently break record creation across the app (S10, pervasive)
- **Severity:** Minor (data-entry/UX + confirms S10 is project-wide)
- **Area:** reference CRUD (and any create form) · **Roles:** all
- **Description:** Same root cause as F1, now confirmed beyond login: typing a `"` (or `\`) into a free-text field of the **Add Client** form makes `createClient` throw **client-side** in the `gql\`\`` builder — the **dialog stays open with no error/feedback** and nothing is saved. Real repair-shop data (addresses, names, descriptions with quotes) cannot be entered.
- **Repro:** Clients → "Ajouter un client" → first name `Bad"Name` + fill other required fields → "Ajouter" → button does nothing; console error only.
- **Root cause:** `client.service.ts addClient()` interpolates raw values into the mutation string (`first_name: "${...}"`). Identical pattern in `company.service.ts`, `profile.service.ts`, `ticket.service.ts` → the whole app is exposed.
- **Evidence:** A3.3 (+ attached `A3.3-client-errors.txt`); no `createClient` request sent.
- **Suggested fix:** parameterized `$variables` (project-wide); this single change resolves F1, F2, F9 and the S10 class.
- **Confirms documented issue?** Yes — S10 (now demonstrated to generalize to entity creation).

### [Major] F10 — Workflow accepts invalid/skipped status transitions (confirms D2 soft-validation)
- **Severity:** Major (data integrity)
- **Area:** DI workflow (backend) · **Roles:** any
- **Description:** A DI in `CREATED` can be moved **straight to `PENDING3`** ("sent to repair") via `changeStatusPending3`, skipping diagnostic, magasin, pricing and negotiation. No error; the status becomes `PENDING3`.
- **Repro:** `createDi` (→`CREATED`) then `mutation { changeStatusPending3(_id) }` → `getDiById` shows `PENDING3`.
- **Root cause:** the workflow engine validates source-status/role **softly** (`strictFrom`/`strictRole` = false → warn, don't block — D2), and the legacy `changeStatus*` methods set status unconditionally.
- **Impact:** tickets can bypass diagnosis/pricing; the `Stat` ledger and dashboard KPIs can desync from reality.
- **Evidence:** H1 test (+ `H1-skip-transition.json`).
- **Suggested fix:** flip `strictFrom` on per transition (the engine already supports it) and route the legacy mutations through the engine.
- **Confirms documented issue?** Yes — D2.

### [Major — confirmed gap] F11 — DI transition mutations are unguarded; any role drives the workflow (S3/F4)
- **Severity:** Major (confirms documented gap)
- **Area:** DI workflow / permissions (backend)
- **Description:** `manager_Pending1` (a Manager/Admin-only step per `STATUS_DI`) **succeeds with a TECH token**. The transition resolvers carry no `JwtAuthGuard` and no role guard; combined with F4, even anonymous calls would execute.
- **Evidence:** H2 test (TECH token → `PENDING1`, no error).
- **Suggested fix:** a working role guard on state-changing mutations (depends on fixing F4 first).
- **Confirms documented issue?** Yes — S3 (and F4).

### [Minor] F12 — Soft-deleted clients are not filtered from `findAllClient` / `getAllClient` (inconsistent with `searchClient`)
- **Severity:** Minor (data hygiene / UX)
- **Area:** reference data (backend)
- **Description:** A direct API probe found `getAllClient` returns 8 clients of which **7 are `isDeleted: true`**, and `findAllClient.totalClientRecord` is also **8**. So both the unfiltered client list **and** the `getAllClient` dropdown source (used when creating a DI) include soft-deleted clients. `searchClient`, by contrast, excludes them (a just-deleted client returned 0 matches in A3.1). Net effect: a "deleted" client still shows in the list and remains **selectable as the customer on a new DI**.
- **Evidence:** API diagnostic — `getAllClient=8 (deleted=7)`, `findAllClient.total=8`.
- **Caveat:** most of those 7 deleted rows are QA test artifacts from this session; the **non-filtering behavior** is the finding, not the count.
- **Suggested fix:** filter `isDeleted` in `findAllClient` and `getAllClient` (as `searchClient` does).
- **Confirms documented issue?** Related to the soft-delete convention (D6).

### [Major — confirmed gap] F13 — Uploaded documents are publicly served with no authentication (confirms S7)
- **Severity:** Major (confirms documented gap; these are customer financial docs — devis/factures)
- **Area:** file serving (backend)
- **Description:** A *devis* uploaded via `addDevis` is written to `docs/<random>.pdf` and served by `ServeStaticModule` **at the web root with no `serveRoot` and no auth**. Fetching `http://localhost:3000/<filename>` **without any token returns 200** and the file bytes.
- **Repro:** create DI → `addDevis(_id, "data:application/pdf;base64,…")` → read `DI.devis` filename → `GET http://localhost:3000/<filename>` with no `Authorization` → 200 + content.
- **Mitigation today:** filenames are random 12-char strings (weak obscurity only — no access control).
- **Evidence:** A8.1 (+ `A8.1-public-file.txt`).
- **Suggested fix:** require auth on document access (e.g. an authenticated download resolver/route), or at minimum move off the web root.
- **Confirms documented issue?** Yes — S7.

### Positive results (no defect — recorded for the regression baseline)
- Valid login fires **exactly one** `login` op (no duplicate submit) and stores `token/_id/role/username` (A1.1).
- Wrong password → GraphQL `errors[]`, no token, stays on login, **error toast shown** (A1.2).
- Unknown username → rejected (A1.3).
- Unauthenticated deep-link to a protected route → redirected to `/auth/login` (A1.6).
- Session persists across full reload (A1.8).
- Logout (topbar profile icon → **Déconnexion**) clears `localStorage` and re-blocks protected routes (A1.9).
- **Per-role sidebar menus are correct** — each of the 6 roles sees exactly its intended links and none of the others (A2 menu tests, all 6 pass). This is the role gating that *does* work (UI-side).
- **Client CRUD happy path works** — create → persists & is searchable → delete (soft) round-trips with no GraphQL errors and a success toast (A3.1).
- **Add-client form validates required fields** — the submit button is disabled until first/last/region/phone/address are filled (A3.2). (Contrast with the login form, F2.)
- **Rapid double-click on submit creates exactly one record** — no duplicate client was created (A3.4).
- **DI creation works** — `createDi` returns a new `_id` in status `CREATED` with no GraphQL errors (A5.1).
- **A valid workflow step works** — `CREATED → PENDING1` via `manager_Pending1` advances the status cleanly (A5.2).
- **Client search works** — the per-column filter returns the matching client; clearing it re-issues `findAllClient` (A6.1, A6.3). (A6.2 also re-confirmed F9/S10 on the search filter: a `"` silently breaks `searchClient` client-side.)
- **Dashboard KPIs are well-formed & internally consistent** — no GraphQL errors; `nbClotures ≤ nbRecus` (A9.1).
- **Counts stay consistent across actions (H3)** — `getStatusCount` reflects a create (`CREATED +1`) and a transition (`CREATED −1`, `PENDING1 +1`) exactly; no desync (A9.2).

<!--
Template per finding:

### [SEV-x] <short title>
- **Severity:** Blocker / Critical / Major / Minor / Trivial
- **Area:** auth | navigation | DI CRUD | DI workflow | search/filter | modals | uploads | dashboard | notifications | permissions | resilience
- **Roles affected:**
- **Description:**
- **Repro steps:**
- **Expected vs actual:**
- **GraphQL evidence:** operationName/rootField, variables, response (errors/data)
- **Evidence files:** test-results/...
- **Likely root cause:**
- **Suggested fix:**
- **Confirms documented issue?** (e.g. known-issues S3/S4/D2) yes/no
-->

---

## Deferred test ideas (scope-brake backlog)

_Captured here instead of being built immediately, per the scope brakes._

- **[Area 7 — modals] Mostly deferred; repair pause/resume + timer-survives-refresh now DONE.** The **Réparation modal pause/resume** flow and the **server-anchored timer (survives refresh)** are fixed, driven through the real UI, and covered by `04-repair-modal.regression.spec.ts` (see both "Fixes applied" sections above). Still deferred: the **diagnostic** modal stepper (reference, untouched) and the **full repair lifecycle to FINISHED** (diagnostic→…→finish, multi-step validation, "contain PDR" conditional step, double-confirm). Suggested approach for those: stage a DI+Stat for the tech (as the repair spec does) and drive each step.
- **[Area 10 — real-time] Socket.io push → auto-refresh not tested (deferred).** Event-timing dependent. Suggested approach: two browser contexts (e.g. coordinator + magasin); perform an action in one and assert the other's list refreshes via the `notification.service` subjects / a re-issued query. Mark `@flaky` and isolate.
- **[Area 11 — resilience] Partial.** Covered: reload persistence (A1.8), rapid double-click (A3.4). Remaining (refresh mid-request, navigate during an in-flight request, multi-tab concurrency) deferred as inherently flaky — isolate and tag `@flaky`.
- **[Area 5/7 — workflow] Full happy-path lifecycle through the UI modals not yet driven end-to-end.** A5 covered create + early transitions via API; the diagnostic/repair **stepper modals** (timer, parts, Stat time-tracking) and the Stat-dependent steps (`changeStatusInDiagnostic`/`changeStatusInRepair`) need UI coverage (Area 7) — they were not driven to `FINISHED`.
- **[Area 9 — workflow] Cross-screen consistency (H3) after a transition not yet checked.** Verify status/counts/KPIs agree across the role workspace, the dashboard, and list views after a transition.
- **[Area 3 — CRUD] Companies & Profiles CRUD not yet UI-tested.** They use the identical `gql`-interpolation create services (`company.service.ts`, `profile.service.ts`) and the same dialog pattern as Clients, so F9/S10 applies to them too. Add explicit company/profile create+validation+delete tests (was capped per scope brake; Clients tested as representative).
- **[Area 9 — dashboard] Tech leaderboard shows raw Mongo ObjectId + dead dummy.** The MANAGER dashboard (seen incidentally in A1.9) renders a technician row whose name is a raw id `69fb49a8fbdfcb7ca81bed0e` (unresolved profile name) and includes `Test Tech` (the dead `testtech` dummy). Verify name resolution + whether soft-deleted/dummy users should appear, in Area 9.
- **[Area 9 — dashboard] MANAGER sees the full dashboard at `/`.** Incidental A1.9 observation: a MANAGER landed on `/` and the full "Tableau de Bord SAV" rendered with real KPIs — ties into the disabled-menu/route-reachable item below; confirm intended visibility in Area 2/9.
- **[Phase 3 — navigation] Post-login landing vs disabled menu mismatch.** After
  login the app always `navigateByUrl('/')`, so every role (incl. TECH,
  COORDINATOR/`COORDIANTOR`, MAGASIN) lands on the **dashboard route** even though
  those roles have the dashboard **menu item disabled**. Verify in Phase 3 what
  these roles actually see at `/` (real KPIs? empty? errors?) and whether the
  dashboard GraphQL queries fire for roles not meant to have it. (Noted at user's
  request; not a Phase-2 failure — login success = token stored + off `/auth/login`.)

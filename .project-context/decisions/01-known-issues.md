# Known Issues, Tech Debt & Fragile Areas

**Purpose:** Catalog the bugs, security risks, and fragile spots found while reading the code, so future work doesn't trust these areas blindly. Each item cites where it lives.

---

## 🔴 Security (address before any non-LAN exposure)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| S1 | **JWT secret hardcoded** as `'hide-me'` | [jwt.strategy.ts:12](../../fix-back/src/auth/jwt.strategy.ts#L12) | Anyone can forge valid tokens for any role. |
| S2 | **Live Discord webhook URL committed in source** | [discord-hook.service.ts:47](../../fix-back/src/discord-hook/discord-hook.service.ts#L47) | Leaked secret; anyone can post to the channel. Rotate + move to env. |
| S3 | **Most GraphQL resolvers are unguarded** | `di.resolver.ts` & others (only a few use `JwtAuthGuard`) | The API is largely open; role checks are UI-only. |
| S4 | **Role authorization is UI-only** | frontend menu/components; backend `RolesGuard`/`@Roles` barely used | A user can call any mutation regardless of role. |
| S5 | **MongoDB has no auth** | [app.module.ts:36](../../fix-back/src/app.module.ts#L36) | Anyone on the network can read/write the DB. |
| S6 | **GraphQL Playground enabled in prod** | [app.module.ts:40](../../fix-back/src/app.module.ts#L40) (`playground: true`) | Schema/introspection exposed. |
| S7 | **Static file dir served publicly, no auth** | `ServeStaticModule` → `docs/` ([app.module.ts:44](../../fix-back/src/app.module.ts#L44)) | All uploaded devis/factures/images are public if the URL is known (random names = weak obscurity only). |
| S8 | **5 GB body-parser limit** | [main.ts:50](../../fix-back/src/main.ts#L50) | DoS via huge base64 uploads. |
| S9 | **JWT in `localStorage`, no expiry refresh** | [graphql.modules.ts:21](../../fix-front/src/app/graphql.modules.ts#L21), login component | XSS-exfiltratable; no rotation. |
| S10 | **Raw GraphQL string interpolation** | frontend services, e.g. [ticket.service.ts:29](../../fix-front/src/app/demo/service/ticket.service.ts#L29) | Injection/escaping bugs; values with quotes break queries. Use `$variables`. |
| S11 | **WS subscriptions carry no auth** | [graphql.modules.ts:40](../../fix-front/src/app/graphql.modules.ts#L40) (token not sent) | Subscription channel is unauthenticated. |
| **S12** | **`JwtAuthGuard` does not enforce authentication — bypass on the "guarded" mutations** | [jwt-auth-guard.ts:17](../../fix-back/src/auth/jwt-auth-guard.ts#L17) — `handleRequest(err, user) { if (user) return user; }` returns `undefined` instead of throwing when there is no user | **More severe than S3.** Passport's `AuthGuard` enforces auth by *throwing* in `handleRequest` when `!user`; this override never throws, so `canActivate` resolves truthy and **anonymous/invalid-token requests pass through with `req.user = undefined`**. The 4 mutations decorated `@UseGuards(JwtAuthGuard)` (`createDi`, `confirmDiComponents`, `sendDiToAdminsForPricing`, `componentConfirmedFromCoordinator`) — the guard assumed to be the *positive control* — execute unauthenticated. Combined with S3 the **entire mutation API is effectively unauthenticated**. Verified at runtime by QA 2026-06-10 (anonymous `confirmDiComponents` returned a domain 404, not `Unauthorized`). Fix: `if (err \|\| !user) throw err \|\| new UnauthorizedException(); return user;` |

## 🟠 Correctness / bugs

| # | Issue | Location |
|---|-------|----------|
| B1 | **E2E test is broken/stale** — asserts `GET / → "Hello World!"` but `AppController` isn't registered (`controllers: []`); also needs a live Mongo to boot | [test/app.e2e-spec.ts](../../fix-back/test/app.e2e-spec.ts), [app.module.ts](../../fix-back/src/app.module.ts) |
| B2 | **`BlockedReason.WAITING_APPROVAL` value has a literal space**: `'WAITING_APPRO VAL'` | [blocked-reason.enum.ts:14](../../fix-back/src/di/blocked-reason.enum.ts#L14) |
| B3 | **Stray `z;` statement** + leftover `console.log` tracing in the DI resolver | [di.resolver.ts:595](../../fix-back/src/di/di.resolver.ts#L595), `changeStatusInRepair` |
| B4 | **Many fire-and-forget boolean mutations** return `true` immediately without awaiting the service (the resolver comments on this for `changeStatusInRepair`, which was fixed; others still do it) | `di.resolver.ts` `changeStatus*` |
| B5 | **`mongo-init.js` referenced by compose but not committed** → empty DB, no seed/first user | [docker-compose-mongo.yml:7](../../fix-back/docker-compose-mongo.yml#L7) |
| B6 | **Redundant double bcrypt compare** in `validateUser`; `login()` re-fetches user and signs without re-verifying | [auth.service.ts](../../fix-back/src/auth/auth.service.ts) |
| B7 | **`_idnum` counter can be re-poisoned by deleted/non-conforming DIs.** `generateClientId` picks the **latest DI by `createdAt`** and does `+lastDi._idnum.substring(2) + 1` with **no `isDeleted` filter** and no `DI<number>` validation. A single non-conforming `_idnum` (e.g. a manually-seeded `TEST01`) or any future soft-deleted record that sorts latest makes the parse `NaN` → the next DI becomes `DINaN`, which then cascades. QA found & removed a live `TEST01` record on 2026-06-10. **Fix (not done):** ignore non-`/^DI\d+$/` rows, filter `isDeleted`, and/or compute `max(numeric _idnum)` instead of latest-by-`createdAt`. | [di.service.ts:125-139](../../fix-back/src/di/di.service.ts#L125) |

## 🟡 Tech debt / fragility

| # | Issue | Notes |
|---|-------|-------|
| D1 | **`DiService` is ~2,900 lines, procedural, untested** | Highest-risk file; many side effects (files, sockets, logs, audit) per method. Read fully before editing. |
| D2 | **DI workflow only half-migrated** | New engine (`di/workflow/`) coexists with dozens of legacy per-edge mutations; validation is "soft" (warns, doesn't block). Two sources of truth for transitions. |
| D3 | **Status strings inconsistently cased** | `PENDING1` vs `MagasinEstimation` vs `DIAGNOSTIC_Pause`. Always use `STATUS_DI` constants. |
| D4 | **Module naming inconsistent** | `ClientsModule`/`CompanysModule` (plural) vs `DiModule` (singular). |
| D5 | **Load-bearing typos** | `avaible`, `getAllComapnyforDropDown`, `getLigsById`, `sendNotifcationToAdmins`, `Companys`. Persisted/contract-coupled — don't rename without a migration. |
| D6 | **Remarques duplicated** | The 7 `remarque_*` fields live on the DI *and* in the `remarque` collection *and* in `logs-di`. Risk of drift. |
| D7 | **Two unrelated real-time systems** | Socket.io gateway + GraphQL subscriptions; the gateway `emit`s to all clients (no rooms), clients filter locally. |
| D8 | **Hardcoded LAN IP `192.168.1.29`** | [environment.prod.ts](../../fix-front/src/environments/environment.prod.ts); breaks on any other network. |
| D9 | **No Apollo caching by design** | `fetchPolicy: 'no-cache'` everywhere → every interaction re-queries; perf depends on the debounce in `ticket-refresh.service.ts`. |
| D10 | **Large amount of template boilerplate** | Sakai-NG demo modules (`uikit`, `primeblocks`, `pages`, `landing`, `documentation`, `utilities`) and demo services remain in the build. |
| D11 | **Version skew** | NestJS core/common v9 with graphql/mongoose/jwt/schedule v10–12. |
| D12 | **File uploads as base64 in GraphQL** | Drives the 5gb limit; memory-heavy. A real upload endpoint (multipart) would be safer. |

---

## Related files
- [02-open-questions.md](02-open-questions.md) — things that need a human decision
- [modules/backend-di-domain.md](../modules/backend-di-domain.md), [operations/03-environment.md](../operations/03-environment.md)

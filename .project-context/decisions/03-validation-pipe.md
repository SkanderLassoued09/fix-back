# Decision: global `ValidationPipe` enabled + company input validation

**Date:** 2026-06-11 · **Scope:** backend `fix-back` (app-wide pipe) + company feature.
**Trigger:** company QA pass found inputs were unvalidated (see
[`qa/COMPANY_QA_REPORT.md`](../../qa/COMPANY_QA_REPORT.md)).

## Context
- The app is **GraphQL**. `main.ts` had **no global `ValidationPipe`**, so every
  `class-validator` decorator on the `@InputType`s was **inert**. GraphQL's schema still
  rejected wrong types / missing-required / unknown fields, but formats, lengths, enums and
  empties passed through.
- The front built company queries by **string interpolation** (`name: "${…}"`) — an injection
  vector (S10) and the source of the persisted literal `"undefined"` for `raisonSociale`.

## Decision
1. **Enable the pipe globally** but minimally:
   `app.useGlobalPipes(new ValidationPipe({ transform: true }))`.
   - `transform: true` is required to (a) run the validators and (b) apply class-transformer
     decorators (`@Trim`, `@Type`).
   - **`forbidNonWhitelisted` deliberately NOT set** — the GraphQL schema is already the
     whitelist, and forbidding unknown props would risk breaking mutations that were never
     validated. `whitelist` left off (not needed in GraphQL).
   - Installed **`class-transformer`** (`^0.5.1`) — it was missing from `fix-back` and is
     mandatory for any `ValidationPipe` (it does `plainToInstance` internally).
2. **Validators** live on the company `@InputType`s only (`create-company.input.ts`):
   `@IsNotEmpty`/`@Trim` on required (`name`, `raisonSociale`), `@IsOptional` + `@IsEmail` /
   `@IsUrl` / `@IsEnum(ExonerationEnum)` / `@MaxLength`, `@ValidateNested` + `@Type` on the
   service contacts. Required-ness mirrors the UI (only `name`+`raisonSociale` mandatory);
   matching `Company` output fields made nullable so reads can't hit a non-null crash.
3. **Front uses typed GraphQL variables** (no interpolation) + prunes empty optionals to
   `undefined` (so `@IsEmail`/`@IsUrl` don't fire on a blank optional) + strips `__typename`.
4. **Errors:** `GraphQLModule.formatError` strips stack traces and surfaces class-validator
   field messages under `extensions.validation` (readable message, no internals).

## Blast-radius check (the reason this is logged)
A global pipe activates the previously-inert validators of **all** modules. Audit of
`*.input.ts` for class-validator decorators:

| Module | Input validators | Effect under the pipe |
|---|---|---|
| `company` | full set (this pass) | intended |
| `remarque` | `@IsString()` only, all required | none — redundant with GraphQL `String!` |
| **all others** (di, clients, composant, profile/auth, stat, …) | **none** | `transform:true` is a no-op (no rejection) |

**Verified (servers up):** company e2e **25/25**; regression **17/17** (login ×6, DI
create→PENDING1, client CRUD, repair modal); search + dashboard **11/11**. No flow broke.

## If you later want stricter validation
Adding validators to other modules' inputs will now take effect immediately (the pipe is on).
Re-run `qa/ npm test` after any such change. Do **not** enable `forbidNonWhitelisted` globally
without a full regression pass.

## Validation drift → Discord (separate dev channel) — 2026-06-12
Validation (`BAD_REQUEST`) errors stay **`notify:false` on the critical channel** (anti-spam),
but their messages are now surfaced on a **separate, dev-only "validation" Discord channel** for
front↔back drift detection.

- **Path:** `AllExceptionsFilter` detects a ValidationPipe `BadRequestException`
  (`getResponse().message` is a `string[]`) → `OperationalErrorService.captureValidation({operation, messages, correlationId})`
  → `DiscordHookService.sendValidationError()` → `DISCORD_VALIDATION_WEBHOOK_URL`.
- **Gating (anti-storm):** active only when `DISCORD_NOTIFY_VALIDATION=true` **AND**
  `NODE_ENV !== 'production'` (OFF by default). Per-key **dedup** (operation + sorted messages,
  `DISCORD_VALIDATION_DEDUP_MS`=10 min) + global **hourly cap** (`DISCORD_VALIDATION_CAP_PER_HOUR`=20;
  excess aggregated into "+N occurrences").
- **No PII:** the embed carries only env, `correlationId`, and the **field+rule messages** — never
  the submitted values/payload.
- **Drift marker:** messages that shouldn't occur if the front gates correctly
  (`should not be empty`, `should not exist`, `must be a <type>`) are flagged "⚠ drift probable"
  (vs a plain user typo like `must be an email`).
- **Unchanged:** the client `BAD_REQUEST` response and the critical channel are untouched; no
  double-notify (distinct channels + own dedup).
- **Verified (flag ON, dev):** bad email + empty `raisonSociale` → **one** validation notif,
  `drift=true`; immediate repeat → **deduped**; different error → notified; flag OFF → **none**,
  critical channel + response intact. Company e2e **27/27** with the default (OFF) config.
- **Best UX note:** the `BAD_REQUEST` response already contains the `message[]` array — the *user*
  fix is showing those inline under each field (done in the company form). The Discord channel is
  the **dev** drift net, not a user-facing path.

Env: `DISCORD_VALIDATION_WEBHOOK_URL`, `DISCORD_NOTIFY_VALIDATION`, `DISCORD_VALIDATION_DEDUP_MS`,
`DISCORD_VALIDATION_CAP_PER_HOUR`.

## Still open (not in this pass)
- `main.ts` `bodyParser` limit is **5gb** (DoS surface) — recommend ~1–5mb.
- No unique constraint on `mf`/`raisonSociale` (no `409` on duplicates).
- Security (guards/RBAC/IDOR/rate-limiting) — dedicated pass, see report's _TODO sécurité_.

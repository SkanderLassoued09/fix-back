# Company feature — QA report (UI + endpoint health)

**Scope:** the « Gestion des sociétés » feature — Angular `company-list` UI and the
GraphQL endpoints it uses. **Security is explicitly out of scope** (a valid admin
token is used only to *reach* the endpoints; see _TODO sécurité_ at the end).
**Last updated:** 2026-06-11.

**Deliverables:** [`playwright.e2e.config.ts`](playwright.e2e.config.ts),
[`e2e/company-list.spec.ts`](e2e/company-list.spec.ts) (UI),
[`e2e/company.api.spec.ts`](e2e/company.api.spec.ts) (input health),
[`e2e/_helpers.ts`](e2e/_helpers.ts), npm scripts `e2e` / `e2e:api` / `e2e:ui`.
Run: backend on :3000 + `ng serve` on :4200, then `npm run e2e` (from `qa/`).

> **The "attached skeleton" for the API spec was not present in the workspace** —
> I built `company.api.spec.ts` from the matrix in the prompt. Ping me if you have
> a specific skeleton to align to.

---

## 0. Inventory

### Architecture reality: this is **GraphQL**, not REST
One endpoint `POST /graphql`; HTTP is **200 even on failure** — success/failure is
in the JSON `data` / `errors`. So the prompt's REST framing maps as:

| Prompt (REST) | GraphQL reality |
|---|---|
| `201` + entity | `data.<op>` with `_id`, no `errors` |
| `200` updated | `data.<op>` reflects the change |
| `4xx` structured | `errors[]` with `extensions.code` ∈ {`GRAPHQL_VALIDATION_FAILED`, `BAD_USER_INPUT`, `NOT_FOUND`, `BAD_REQUEST`} |
| `404` | `errors[].extensions.code = 'NOT_FOUND'` |
| **`500` (bug)** | HTTP ≥ 500 **or** `extensions.code = 'INTERNAL_SERVER_ERROR'` **or** a non-nullable-field violation |

The **gold rule** ("invalid input → 4xx, never 500") becomes: *invalid input must never
produce `INTERNAL_SERVER_ERROR` / a non-null crash / a leaked stack trace.*

### Angular service — [`company.service.ts`](../fix-front/src/app/demo/service/company.service.ts)
All operations build the query by **raw string interpolation** (`name: "${...}"`),
not GraphQL variables:

| Method | GraphQL op | Notes |
|---|---|---|
| `addCompany(info)` | `createCompany(createCompanyInput)` | interpolates 12 fields + 3 service sub-objects |
| `updatecompany(c)` | `updateCompany(updateCompanyInput)` | interpolates 9 fields |
| `removeCompany(_id)` | `removeCompany(_id)` | soft-delete |
| `getAllCompany(first,row)` | `findAllCompany(PaginationConfig)` | list + total |
| `searchCompany(field,value,…)` | `searchCompany(...)` | per-field regex |
| `findOneCompany(_id)` | `findOneCompany(_id)` | — |

### NestJS — [`company.resolver.ts`](../fix-back/src/company/company.resolver.ts) · [DTOs](../fix-back/src/company/dto/create-company.input.ts) · [entity](../fix-back/src/company/entities/company.entity.ts)
- `CreateCompanyInput`, `UpdateCompanyInput`, `PaginationConfig`, `ServiceContactInput`.
- **No global `ValidationPipe`** in [`main.ts`](../fix-back/src/main.ts) → every
  `class-validator` decorator (`@IsEmail`, `@IsPhoneNumber`, `@IsString`, `@IsBoolean`)
  is **inert**. `UpdateCompanyInput` has no validators at all.
- `main.ts`: `bodyParser` limit **`5gb`**, `enableCors()` (permissive).

### Correspondence table (Angular form → Create DTO)
Form group `companyForm` (`company-list.component.ts`).

| Form control | Sent as (create) | `CreateCompanyInput` | Required by DTO | Note |
|---|---|---|---|---|
| `companyName` | `name` | `name` String! `@IsString` | yes | label says « Raison sociale » but maps to `name` |
| `region` (object) | `region.name` | `region` String! `@IsString` | yes | object → `.name` |
| `address` | `address` | `address` String! | yes | no validator |
| `email` | `email` | `email` `@IsEmail` nullable | no | front sends `""` when empty |
| `phone` | — | *(none)* | — | **front field never sent** (no `phone` on DTO) |
| `fax` | `fax` | `fax` `@IsPhoneNumber` nullable | no | |
| `Exoneration` | `Exoneration` | `Exoneration` nullable | no | **no `@IsEnum`** (Oui/Non) |
| `website` | `webSiteLink` | `webSiteLink` nullable | no | **no `@IsUrl`** |
| `rne` | `rne` | `rne` String! | yes | no format validator |
| `mf` | `mf` | `mf` String! | yes | no format validator |
| `activitePrincipale` | `activitePrincipale` | `activitePrincipale` String! `@IsString` | yes | |
| `activiteSecondaire` | `activiteSecondaire` | `activiteSecondaire` nullable | no | |
| *(none)* | `raisonSociale` | `raisonSociale` String! | yes | **front sends the literal string `"undefined"`** (no `raisonSociale` control) |
| `achat/technique/financier.{fullName,phone,email}` | `serviceAchat/Technique/Financier.{name,phone,email}` | `ServiceContactInput` | no | `fullName`→`name` |

**Mismatches:** ① `raisonSociale` is **required by the DTO but the form has no such control**
→ it ships the literal `"undefined"`. ② `phone` exists on the form but is never sent.
③ `UpdateCompanyInput` persists only `name, region, address, email, Exoneration, raisonSociale,
fax, webSiteLink, rne, mf` — the modal also collects activités + contacts, which **update silently drops**.

---

## 1. Findings

Severity: 🔴 critical · 🟠 major · 🟡 minor. Status as of this report.

| # | Sev | Area | Finding | Evidence | Status |
|---|---|---|---|---|---|
| C1 | 🔴 | API | `removeCompany`/`updateCompany` on a **non-existent id returned `null` into a non-nullable `Company`** → `INTERNAL_SERVER_ERROR` **with a full stack trace leaked** in `extensions.stacktrace`. | `company.api.spec.ts` not-found test (was red) | ✅ **fixed** |
| C2 | 🔴 | API | Apollo **leaked stack traces** (`extensions.stacktrace`) on *every* error. | same response | ✅ **fixed** (global `formatError`) |
| C3 | 🔴 | API | `createcompany` did `.catch(err => return err)` → **DB errors masked as a "successful" Company**. | code read | ✅ **fixed** (let it propagate) |
| M1 | 🟠 | API | **No input validation** (no global `ValidationPipe`): empty/whitespace required, malformed email, non-URL website, `Exoneration` out of enum, 10 000-char overflow, invalid `serviceAchat.email` all **accepted**. | 7 gaps logged by API spec | ✅ **fixed** (validation pass — §2b) |
| M2 | 🟠 | front+API | `raisonSociale` **required by DTO but absent from the form** → ships literal `"undefined"`; **2/2 existing rows corrupted**. | data scan | ✅ **fixed** (front maps it; 2 rows backfilled) |
| M3 | 🟠 | API | Soft-deleted companies (`isDeleted:true`) **still appeared in `findAllCompany`** (no filter). | code read | ✅ **fixed** |
| M4 | 🟠 | front | `updateCompany` **silently drops** activités + service contacts (not in `UpdateCompanyInput`/service `$set`). | correspondence table | ✅ **fixed** (input + `$set` + front extended) |
| S10 | 🟠 | front | Company ops built the query by **string interpolation** (`name:"${…}"`) → injection / a `"` breaks the query. | code read | ✅ **fixed** (front → typed variables) |
| M5 | 🟠 | API/robustness | `bodyParser` limit **`5gb`** → huge-payload DoS surface. | `main.ts` | ⚠️ open (recommend ~1–5mb) |
| m1 | 🟡 | API | No unique constraint on `mf`/`raisonSociale` → silent duplicates (no `409`). | code read | open (by design? confirm) |
| m2 | 🟡 | API | `searchCompanies(name)` queries non-existent field `company_name` → always empty. | code read | open (unused by list) |
| m3 | 🟡 | API | Many `Company` fields were non-nullable `@Field()`; a row missing `mf`/`rne`/`address` made **reads** crash. | entity | ✅ **fixed** (aligned nullable on input + output) |

**Good results (no defect):**
- Wrong types, missing-required, explicit `null`, and unknown/extra fields are **rejected by
  the GraphQL schema itself** (`GRAPHQL_VALIDATION_FAILED` / `BAD_USER_INPUT`) — no crash.
- Malformed JSON → `400`; wrong `Content-Type` → `4xx`.
- Unicode/emoji accepted cleanly.
- UI: required-gating, chips add/remove, Esc-close, edit-prefill, delete-name, **390 px no
  horizontal scroll, zero console errors** — all green.

---

## 2. Fixes applied (this pass)

Backend, scoped to the company feature + one global error-sanitiser:

- **`company.service.ts`**: `createcompany` no longer swallows errors (C3); `removeCompany`
  uses `{new:true}` + throws a `GraphQLError {code:'NOT_FOUND'}` when absent (C1); same for
  `updateCompany` + `findOneCompany`; `findAllCompanys` filters `isDeleted: { $ne: true }` (M3).
- **`company.resolver.ts`**: dropped the `try/catch` on `removeCompany` that never caught the
  async rejection and masked 404 → 500.
- **`app.module.ts`**: `GraphQLModule.formatError` strips `stacktrace`/internal detail and
  keeps `{ message, extensions.code, path }` (C2) — applies app-wide, output-only (no behaviour change).

**Verification:** `company.api.spec.ts` → **20/20 green** (gold rule holds everywhere; not-found
now `NOT_FOUND`, no stack trace). `company-list.spec.ts` → **4/4 green**.

---

## 2b. Validation hardening pass — DONE (2026-06-11)

Closed M1/M2/M4/S10/m3 in four verified phases (see
[`.project-context/decisions/03-validation-pipe.md`](../.project-context/decisions/03-validation-pipe.md)):

1. **Correctness/data** — front maps the single « Raison sociale » field to both `name` and
   `raisonSociale` (M2); the **2 corrupted rows** (`raisonSociale="undefined"`) were backfilled
   `raisonSociale = name`. Added company-level `phone` (was collected, never sent). Completed
   `UpdateCompanyInput` + the service `$set` with phone/activités/contacts (M4).
2. **Front → GraphQL variables** — `addCompany`/`updatecompany`/`removeCompany`/`findAll`/
   `searchCompany`/`findOne` migrated from string interpolation to typed `variables`, with
   empty-optional **pruning** + `__typename` stripping (closes **S10**; lets validators run).
3. **Validators** — `CreateCompanyInput`/`UpdateCompanyInput`: `@IsNotEmpty`+`@Trim` on
   required, `@IsOptional`+`@IsEmail`/`@IsUrl`/`@IsEnum(ExonerationEnum)`/`@MaxLength`,
   `@ValidateNested`+`@Type` on the service contacts. Required-ness aligned to the UI (only
   `name`+`raisonSociale` mandatory); the matching `Company` output fields made nullable so
   reads can't crash (m3). Installed **`class-transformer`** (was missing — required by the pipe).
4. **Global `ValidationPipe({ transform: true })`** in `main.ts` — **no `forbidNonWhitelisted`**
   (GraphQL is already the whitelist; avoids breaking unvalidated mutations). `formatError`
   now surfaces per-field messages (`extensions.validation`) without leaking stack traces.

**Result:** the 7 former gaps are **rejected** (`BAD_REQUEST` + readable per-field message, e.g.
*"email must be an email; Exoneration must be one of the following values: Oui, Non"*), valid
create/update/delete/list stay green.

**Verification:** company e2e **25/25**; blast-radius smoke **green** — regression (auth ×6, DI
create→PENDING1, client CRUD, repair modal) **17/17**, search + dashboard (DI create→transition,
status counts) **11/11**. Only one *other* module has input validators (`remarque`, `@IsString`
only — redundant with GraphQL `String!`, no behaviour change); all other modules have none, so
`transform:true` is a no-op there.

**Still open:** M5 (5gb body limit), m1 (no unique constraint → no 409), m2 (`searchCompanies`
dead query).

---

## TODO sécurité (plus tard — non couvert ici)
- `401` sans token · `403` RBAC par rôle (Coordinatrice / Technicien) · token expiré/altéré.
- **IDOR** : accès/édition/suppression d'une société d'autrui.
- Rate-limiting ; `enableCors()` permissif ; GraphQL `playground:true` exposé en prod.
- `5gb` body limit (aussi un vecteur DoS).

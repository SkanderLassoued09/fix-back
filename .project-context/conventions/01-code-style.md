# Code Style & Conventions

**Purpose:** Capture the conventions *actually* used (not aspirational), so new code blends in.

---

## Formatting (both projects)
- **Single quotes**, **trailing commas**, semicolons. Backend Prettier config: [`.prettierrc`](../../fix-back/.prettierrc). Frontend uses `.editorconfig` (4-space indent, LF, final newline).
- **Indent:** 4 spaces in the frontend; backend follows Prettier defaults (2 spaces in `.ts`).
- Run formatters before committing: backend `npm run format` (Prettier) and `npm run lint` (ESLint `--fix`); frontend `npm run lint` (Angular ESLint).

## TypeScript strictness
- **Both projects run loose.** Backend `tsconfig.json`: `strictNullChecks: false`, `noImplicitAny: false`. Frontend `tsconfig.json`: `strict: false`.
- ESLint disables `no-explicit-any`, `explicit-function-return-type`, `explicit-module-boundary-types` ([`.eslintrc.js`](../../fix-back/.eslintrc.js)). `any` is common; return types are optional. **Avoid adding new `any` where a type is easy**, but it's not enforced.

---

## Backend (NestJS) patterns
- **Module per feature**: `src/<feature>/` with `<feature>.module.ts`, `<feature>.resolver.ts`, `<feature>.service.ts`, `dto/`, `entities/`. All feature modules are imported in [`app.module.ts`](../../fix-back/src/app.module.ts).
- **GraphQL is code-first**: `@ObjectType()`/`@Field()` on output classes, `@InputType()` on DTOs; schema auto-generated (`autoSchemaFile: true`). No hand-written `.graphql` SDL.
- **Mongoose entities**: `@Schema({ timestamps: true })` + `@Prop()` document class, paired with a separate `@ObjectType()` GraphQL class in the same `*.entity.ts` file. IDs are **strings**; refs store string ids.
- **Resolvers are thin**, services hold the logic. `DiService` is the extreme (~2,900 lines, procedural, many side effects).
- **Imports across modules use absolute `src/...` paths** (e.g. `import { Role } from 'src/auth/roles'`), enabled by `tsconfig` `baseUrl` + `tsconfig-paths`.
- **Soft delete** (`isDeleted`) instead of hard delete.
- **Naming is inconsistent** — plural (`ClientsModule`, `CompanysModule`) vs singular (`DiModule`). Match the module you're editing.
- **Don't "fix" stored-data typos** (`avaible`, `getAllComapnyforDropDown`, `getLigsById`, `WAITING_APPRO VAL`, `sendNotifcationToAdmins`) without a migration — they're persisted/contract-coupled.

## Frontend (Angular) patterns
- **Selectors:** `app` prefix; elements kebab-case (`app-foo`), attribute directives camelCase (Angular ESLint enforces).
- **Module-per-feature, lazy-loaded.** Each feature has `<feature>.module.ts` + `<feature>-routing.module.ts`; components co-locate `.ts/.html/.scss/.spec.ts` and an `.interface(s).ts`.
- **Constants** live in `constant/` subfolders (e.g. `profile/constant/role-constants.ts`); **utils** in `*-utils.ts`; SCSS partials prefixed `_`.
- **GraphQL queries** are built inline with `gql` tagged templates, mostly via **raw string interpolation** (see the warning below). New code should prefer **parameterized `$variables`** (cf. `dashboard.service.ts`).
- **State sharing** does **not** use the Apollo cache (`no-cache` everywhere) — components re-query after notifications, debounced by `ticket-refresh.service.ts`.
- **Auth/role** read from `localStorage`; role gating is UI-only.

---

## ⚠️ Patterns to avoid replicating (present but undesirable)
- Raw GraphQL string interpolation (injection/escaping risk) — [frontend-services-and-apollo.md](../modules/frontend-services-and-apollo.md).
- Secrets in source (JWT secret, Discord webhook) — [decisions/01-known-issues.md](../decisions/01-known-issues.md).
- `console.log` tracing left in resolvers (e.g. `changeStatusInRepair`) and stray tokens (`z;` in `di.resolver.ts`).
- Hardcoded LAN IPs in environment files.

---

## Language note
The domain is **French**; identifiers freely mix French and English (`remarque`, `tarif`, `devis`, `findAllClient`). Keep new domain terms consistent with existing French naming where the surrounding code uses it.

---

## Related files
- [02-testing.md](02-testing.md), [03-git-workflow.md](03-git-workflow.md)
- [`fix-back/.eslintrc.js`](../../fix-back/.eslintrc.js), [`fix-front/.eslintrc.json`](../../fix-front/.eslintrc.json)

# Tech Stack

**Purpose:** Enumerate the languages, frameworks, libraries, and versions in use on both sides, grounded in the two `package.json` files.

---

## Backend — `fix-back/` ([package.json](../../fix-back/package.json))

- **Language:** TypeScript `^4.7.4`, compiled to CommonJS, target `es2017` ([tsconfig.json](../../fix-back/tsconfig.json)). `strictNullChecks: false`, `noImplicitAny: false` (loose).
- **Runtime:** Node.js (Docker base image `node:20-alpine`).
- **Framework:** NestJS **9** (`@nestjs/core`, `@nestjs/common` `^9.0.0`).

| Concern | Library | Version |
|---------|---------|---------|
| GraphQL server | `@nestjs/graphql`, `@nestjs/apollo`, `apollo-server-express` | 12.x / 3.13 |
| GraphQL subscriptions | `graphql-subscriptions` | ^2.0.0 |
| Database | `mongoose`, `@nestjs/mongoose` | 8.2 / 10.0 |
| Auth | `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`, `passport-local`, `bcrypt` | 10.x / 4.0 / 1.0 / 5.1 |
| Realtime | `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io-client` | 9.x / 4.7 |
| Scheduling | `@nestjs/schedule` | ^4.0.2 |
| Static files | `@nestjs/serve-static` | ^4.0.2 |
| HTTP platform | `@nestjs/platform-express` | ^9.0.0 |
| Google integration | `googleapis` | ^144.0.0 |
| HTTP client | `axios` | ^1.16.0 |
| Validation | `class-validator` | ^0.14.1 |
| Misc | `moment`, `nanoid`, `randomstring`, `uuid`, `dotenv`, `rxjs` | — |
| Testing | `jest` 29, `ts-jest`, `supertest`, `@nestjs/testing` | — |
| Lint/format | ESLint 8 + `@typescript-eslint` 5, Prettier 2 | — |

> ⚠️ Version skew: NestJS **core/common are v9** but `@nestjs/graphql`/`mongoose`/`jwt`/`schedule` are v10–12 (newer). This works but is unusual; be careful when upgrading.

---

## Frontend — `fix-front/` ([package.json](../../fix-front/package.json))

- **Language:** TypeScript `~5.2.2`. `strict: false` in tsconfig.
- **Framework:** Angular **17** (`@angular/*` `^17.0.5`). Module-based (NgModules, not standalone), lazy-loaded routes.
- **Template:** Sakai-NG (PrimeNG admin template), `package.json` `name: "sakai-ng"`, version `17.0.0`.

| Concern | Library | Version |
|---------|---------|---------|
| UI components | `primeng`, `primeflex`, `primeicons` | 17.2 / 3.3 / 7.0 |
| GraphQL client | `apollo-angular`, `@apollo/client`, `graphql` | 6.0 / 3.9 / 16.8 |
| Charts | `chart.js` | ^3.9.1 |
| Calendar | `@fullcalendar/*` (angular, core, daygrid, interaction, timegrid) | ^6.0.3 |
| PDF | `jspdf`, `jspdf-autotable`, `ng2-pdf-viewer` | 2.5 / 3.8 / 10.3 |
| Excel | `xlsx` (SheetJS) | ^0.18.5 |
| Rich text | `quill` | ^1.3.7 |
| Syntax highlight | `prismjs` | ^1.29.0 |
| File save | `file-saver` | ^2.0.5 |
| Date | `moment` | ^2.30.1 |
| PWA | `@angular/service-worker` (+ `ngsw-config.json`) | ^17.0.5 |
| Reactive | `rxjs`, `zone.js` | 7.8 / 0.14 |
| Testing | Karma 6.4 + Jasmine 4.6 | — |

---

## API contract between the two

- **Transport:** GraphQL over HTTP (`POST {apiUrl}graphql`) for queries/mutations; **WebSocket** (`ws://…/graphql`, subprotocol `graphql-ws`) for subscriptions. See [04-integrations.md](../architecture/04-integrations.md).
- **Schema generation:** Code-first — the backend auto-generates `schema.gql` at runtime (`autoSchemaFile: true` in [`app.module.ts`](../../fix-back/src/app.module.ts)). There is **no** committed schema file or generated client; the frontend hand-writes `gql` strings.
- **Auth:** JWT bearer token in the `Authorization` header (HTTP only — the WS link does **not** send the token).

---

## Related files
- [`fix-back/package.json`](../../fix-back/package.json), [`fix-front/package.json`](../../fix-front/package.json)
- [01-system-overview.md](../architecture/01-system-overview.md) — how these pieces connect
- [01-code-style.md](../conventions/01-code-style.md) — linter/formatter config

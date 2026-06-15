# Fixtronix ERP — Agent Guide

This document describes the architecture, technology stack, and development conventions of the Fixtronix ERP project. It is intended for AI coding agents that need to navigate, modify, or extend the codebase.

---

## Project Overview

Fixtronix ERP is a full-stack repair-management system (French: _Demande d'Intervention_ — DI). It tracks repair tickets from intake through diagnostic, parts procurement, and final repair. The stack is:

- **Backend** — NestJS 9 (Node.js, TypeScript)
- **Frontend** — Angular 17 (TypeScript)
- **API** — GraphQL (code-first, Apollo Server / Apollo Angular)
- **Database** — MongoDB (Mongoose ODM)
- **Real-time** — Socket.io WebSocket gateway + custom GraphQL subscription WebSocket link
- **Authentication** — JWT + Passport (local & JWT strategies) with role-based access control

The project is split into two sibling directories:

```
fix-back/   ← NestJS backend (port 3000)
fix-front/  ← Angular SPA (port 4200)
```

Both directories are independent Node.js projects with their own `package.json`, Docker files, and tooling configuration.

---

## Technology Stack

### Backend (`fix-back/`)

| Layer        | Technology                                                           |
| ------------ | -------------------------------------------------------------------- |
| Framework    | NestJS 9 (`@nestjs/core`, `@nestjs/common`)                          |
| API          | GraphQL code-first (`@nestjs/graphql`, `apollo-server-express`)      |
| Database     | MongoDB 6.0, Mongoose 8 (`@nestjs/mongoose`)                         |
| Auth         | Passport (`passport-local`, `passport-jwt`), `bcrypt`, `@nestjs/jwt` |
| Real-time    | `@nestjs/websockets` + `@nestjs/platform-socket.io`                  |
| Scheduling   | `@nestjs/schedule` (cron jobs)                                       |
| Integrations | Google Sheets API (`googleapis`), Discord webhooks                   |
| Testing      | Jest 29, Supertest, `@nestjs/testing`                                |

### Frontend (`fix-front/`)

| Layer          | Technology                                         |
| -------------- | -------------------------------------------------- |
| Framework      | Angular 17 (`@angular/*`)                          |
| UI Library     | PrimeNG 17, PrimeFlex, PrimeIcons                  |
| GraphQL Client | `apollo-angular`, `@apollo/client`                 |
| Charts         | Chart.js                                           |
| Calendar       | FullCalendar                                       |
| PDF            | jsPDF, `jspdf-autotable`, `ng2-pdf-viewer`         |
| Excel          | SheetJS (`xlsx`)                                   |
| Editor         | Quill                                              |
| Testing        | Karma + Jasmine                                    |
| PWA            | Angular Service Worker (`@angular/service-worker`) |

---

## Directory Structure

### Backend (`fix-back/`)

```
fix-back/
├── src/
│   ├── main.ts                 # Bootstrap: NORMAL (HTTP/GraphQL/WS) or ACTION (one-off scripts)
│   ├── app.module.ts           # Root module, imports all feature modules + Mongoose + GraphQL
│   ├── app.controller.ts
│   ├── app.service.ts
│   ├── notification.gateway.ts # Socket.io gateway for real-time push notifications
│   ├── client.status.ts
│   ├── alerts/
│   ├── audit/                  # Audit logging
│   ├── auth/                   # JWT/Passport auth, guards, strategies, roles
│   ├── clients/
│   ├── company/
│   ├── composant/              # Parts/components inventory
│   ├── composant_category/
│   ├── cron/                   # Scheduled jobs & ACTION dispatcher
│   ├── dashboard-kpi/          # KPIs & analytics
│   ├── di/                     # Core domain: repair tickets (DI)
│   │   ├── workflow/           # DI workflow engine (transitions, states)
│   │   ├── entities/
│   │   ├── dto/
│   │   ├── di.status.ts
│   │   └── blocked-reason.enum.ts
│   ├── di_category/
│   ├── discord-hook/
│   ├── google-sheets/          # Google Sheets sync (with mappers/ subdirectory)
│   ├── location/               # Physical locations / warehouses
│   ├── logs-di/                # DI activity logs
│   ├── operational-error/
│   ├── profile/                # User profiles & roles
│   ├── pubsub/                 # GraphQL PubSub module
│   ├── remarque/               # Remarks / notes
│   ├── stagnation/             # Stagnation detection for DIs
│   ├── stat/                   # Statistics
│   └── tarif/                  # Pricing / tariffs
├── test/
│   ├── app.e2e-spec.ts         # End-to-end smoke test
│   └── jest-e2e.json
├── Dockerfile
├── docker-compose-fixtronix.yml
├── docker-compose-mongo.yml
├── package.json
├── tsconfig.json / tsconfig.build.json
├── nest-cli.json
├── .eslintrc.js
└── .prettierrc
```

### Frontend (`fix-front/`)

```
fix-front/
├── src/
│   ├── main.ts
│   ├── index.html
│   ├── styles.scss
│   ├── environments/
│   │   ├── environment.ts          # Dev: apiUrl=http://localhost:3000/
│   │   └── environment.prod.ts     # Prod: apiUrl=http://192.168.1.29:3000
│   ├── app/
│   │   ├── app.module.ts
│   │   ├── app-routing.module.ts   # Lazy-loaded feature modules
│   │   ├── app.component.ts
│   │   ├── graphql.modules.ts      # Apollo client setup (HTTP + custom WS link)
│   │   ├── demo/
│   │   │   ├── components/
│   │   │   │   ├── auth/           # Login, access denied, error pages
│   │   │   │   ├── client/         # add-client, client-list
│   │   │   │   ├── company/        # add-company, company-list
│   │   │   │   ├── dashboard/      # KPI dashboard, period-filter
│   │   │   │   ├── ticket/         # DI management (very deep sub-tree)
│   │   │   │   │   ├── add-ticket/
│   │   │   │   │   ├── ticket-list/
│   │   │   │   │   │   ├── tech-di-list/         → diagnostic-modal (steps/, components/)
│   │   │   │   │   │   ├── tech-repair-list/     → repair-modal (steps/)
│   │   │   │   │   │   ├── coordinator-di-list/
│   │   │   │   │   │   └── magasin-di-list/      → details-composant
│   │   │   │   │   └── composant-management/
│   │   │   │   ├── profile/        # profile-list
│   │   │   │   ├── uikit/          # PrimeNG UI demos
│   │   │   │   ├── pages/          # CRUD, timeline, empty page demos
│   │   │   │   ├── utilities/      # Icons
│   │   │   │   ├── documentation/
│   │   │   │   ├── primeblocks/
│   │   │   │   ├── landing/
│   │   │   │   └── notfound/
│   │   │   └── service/            # Business services
│   │   │       ├── ticket.service.ts         # Core DI GraphQL operations
│   │   │       ├── client.service.ts
│   │   │       ├── company.service.ts
│   │   │       ├── profile.service.ts
│   │   │       ├── notification.service.ts   # Push notifications / web workers
│   │   │       ├── ticket-refresh.service.ts
│   │   │       └── dashboard-data/
│   │   └── layout/                 # Shell layout (sidebar, topbar, menu, footer)
│   └── ...
├── Dockerfile
├── docker.compose.yml
├── angular.json
├── package.json
├── tsconfig.json / tsconfig.app.json / tsconfig.spec.json / tsconfig.worker.json
├── ngsw-config.json                # Service Worker config
├── .eslintrc.json
└── .editorconfig
```

---

## Build and Run Commands

### Backend

```bash
cd fix-back
npm install

# Development (watch mode)
npm run start:dev

# Production
npm run build
npm run start:prod

# One-off action scripts (no HTTP server)
npm run action:detect-stagnant-di      # Detects stagnant DIs
npm run action:sync-google-sheets      # Syncs data to Google Sheets

# Lint & format
npm run lint
npm run format

# Tests
npm run test           # Unit tests (Jest)
npm run test:cov       # Coverage
npm run test:e2e       # End-to-end tests
```

### Frontend

```bash
cd fix-front
npm install

# Development server
npm start              # ng serve → http://localhost:4200

# Production build
npm run build          # Output in dist/

# Tests
npm run test           # Unit tests (Karma + Jasmine)
npm run e2e            # End-to-end (requires additional package)

# Lint
npm run lint
```

---

## Docker Setup

Both projects provide Docker / Docker Compose files for local development. They rely on an **external network** named `hostglobal` that must exist beforehand:

```bash
docker network create hostglobal
```

### MongoDB

```bash
cd fix-back
docker compose -f docker-compose-mongo.yml up -d
# Exposes MongoDB on localhost:27017
# Data persisted in ./database
# Init script: ./mongo-init.js
```

### Backend Container

```bash
cd fix-back
docker compose -f docker-compose-fixtronix.yml up -d
# Container: fixtronix-backend
# Ports: 3000:3000
# Loads environment from .env
# Source volume-mounted to /app
```

### Frontend Container

```bash
cd fix-front
docker compose -f docker.compose.yml up -d
# Container: node-fixtronix
# Ports: 4200:4200
# Source volume-mounted to /app
```

**Note:** The Dockerfiles are minimal development images. The backend image only installs `@nestjs/cli`. The frontend image installs `pnpm` and `@angular/cli`. Neither contains a baked production build; they expect source to be mounted at runtime.

---

## Environment Variables

### Backend (`fix-back/.env`)

The backend expects a `.env` file (loaded by `dotenv` in `main.ts` before any other imports). At minimum, the following variables are referenced across the codebase:

- `GOOGLE_SHEETS_ID` — Google Sheets integration target
- `ACTION` — Triggers one-off script mode when set (e.g. `DETECT_STAGNANT_DI`, `SYNC_GOOGLE_SHEETS`)

No `.env.example` file exists in the repo; inspect `src/` files and Docker compose files to discover required variables.

### Frontend (`fix-front/src/environments/`)

- `apiUrl` — Backend base URL (dev: `http://localhost:3000/`, prod: `http://192.168.1.29:3000`)
- `host` — Frontend host URL

---

## Code Style Guidelines

### TypeScript / General

- **Quote style:** Single quotes (enforced by `.prettierrc` and `.editorconfig`).
- **Trailing commas:** Required (Prettier config).
- **Indent:** 4 spaces (`.editorconfig`).
- **Line endings:** Unix-style (`\n`), final newline required.

### Backend

- **Framework patterns:** Classic NestJS modular architecture. Each feature lives in its own module folder with `{feature}.module.ts`, `{feature}.resolver.ts`, `{feature}.service.ts`, plus `dto/` and `entities/` subdirectories.
- **GraphQL:** Code-first. Entities are decorated with `@nestjs/graphql` decorators; the schema is auto-generated (`autoSchemaFile: true`).
- **MongoDB:** Mongoose schema-first. Document classes use `@nestjs/mongoose` decorators.
- **Imports:** Use absolute path aliases (`src/...`) rather than relative paths when crossing module boundaries.
- **Return types:** `explicit-function-return-type` is disabled in ESLint; return types are optional.
- **`any`:** Allowed (`@typescript-eslint/no-explicit-any: off`), but avoid introducing new `any` usage unless strictly necessary.

### Frontend

- **Component selectors:** Must use `app` prefix, kebab-case for elements (`app-my-component`).
- **Directive selectors:** Must use `app` prefix, camelCase for attributes.
- **Template linting:** Enabled for inline templates.
- **Strict mode:** `strict: false` in `tsconfig.json`.
- **GraphQL:** Queries are built with `gql` tagged template literals and string-interpolated variables. Be extremely careful with string interpolation to avoid injection issues; the codebase currently interpolates raw values into GraphQL strings in several places.

---

## Testing Instructions

### Backend

- **Unit tests:** Co-located next to source files as `*.spec.ts`. Jest configuration is inline in `package.json`.
  - `rootDir: src`
  - `testRegex: .*\.spec\.ts$`
  - `moduleNameMapper: { "^src/(.*)$": "<rootDir>/$1" }`
- **E2E tests:** Located in `test/app.e2e-spec.ts`, configured by `test/jest-e2e.json`.

Run tests with:

```bash
npm run test
npm run test:cov
npm run test:e2e
```

### Frontend

- **Unit tests:** Co-located as `*.spec.ts` inside component directories.
- **Runner:** Karma + Jasmine.
- **Config:** Referenced in `angular.json` (Karma config file path is specified there).

Run tests with:

```bash
npm run test
```

---

## Security Considerations

- **Authentication:** JWT tokens are issued on login and stored in `localStorage` on the frontend under the key `token`. The `authGuard` checks authentication before allowing route access.
- **GraphQL Authorization:** The Apollo link in `graphql.modules.ts` injects `Authorization: Bearer <token>` from `localStorage` on every HTTP request. The custom WebSocket link does **not** forward the JWT; subscriptions rely on the WebSocket connection itself.
- **CORS:** Enabled on the backend (`app.enableCors()`).
- **Password hashing:** `bcrypt` is used for password storage.
- **Role-based access:** Custom `RoleGuard` and `@Roles()` decorator protect resolver methods. Roles are defined in `auth/roles.ts`.
- **Body parser limit:** Set to an unusually high value (`5gb`). This is intentional for file uploads but should be reviewed if the app is exposed to the public internet.
- **GraphQL Playground:** Enabled in production (`playground: true`). Consider disabling it for publicly deployed instances.
- **MongoDB connection:** Defaults to `mongodb://localhost:27017/fixtronix` (no auth). The commented-out Atlas URI in `app.module.ts` suggests production deployments may switch to MongoDB Atlas.

---

## Architecture Notes

### Dual-Mode Bootstrap (`fix-back/src/main.ts`)

The backend has two execution modes controlled by the `ACTION` environment variable:

1. **NORMAL** (default) — Starts the full HTTP + GraphQL + WebSocket server on port 3000.
2. **ACTION** — Boots a minimal NestJS application context and delegates to `AppCronService.runAction()`. Used for background scripts (stagnation detection, Google Sheets sync) without starting the HTTP server.

Adding a new action:

1. Add a case in `AppCronService.runAction()`.
2. Add a trigger method in `AppCronService` (or delegate to a dedicated service).
3. Add an npm script alias in `package.json` (optional).

### Real-Time Stack

- **Socket.io:** `NotificationsGateway` (`notification.gateway.ts`) pushes events to connected clients.
- **GraphQL Subscriptions:** The frontend uses a **custom WebSocket link** (not `subscriptions-transport-ws` or `graphql-ws` libraries) that manually handles `connection_init`, `start`, `data`, `complete`, and `error` message types over a native `WebSocket`.

### DI Workflow Engine

The `di/workflow/` subdirectory contains a small state-machine engine for repair ticket lifecycle management (`di-workflow.service.ts`, `di-transition.map.ts`). Transitions define valid status changes and are separate from the main DI service.

---

## Common Pitfalls

- **GraphQL string interpolation:** Several frontend services (notably `ticket.service.ts`) build GraphQL queries by interpolating raw JavaScript variables into template strings. This is fragile and can break query syntax if values contain quotes or special characters. Prefer parameterized queries (`$variable` definitions) when adding new operations.
- **Environment file drift:** The dev and prod environment files contain hard-coded LAN IPs (`192.168.1.29`). Update them to match the actual deployment network.
- **Missing `.env.example`:** There is no reference `.env` file. Required environment variables must be discovered by grepping `process.env` usage in the backend source.
- **Frontend fetch policy:** Apollo is configured with `fetchPolicy: 'no-cache'` for queries. Do not rely on the Apollo cache for state sharing; the app expects fresh server data on every query.
- **Module naming inconsistency:** Some backend modules use plural naming (`ClientsModule`, `CompanysModule`) while others use singular (`DiModule`, `TarifModule`). Follow the existing convention of the specific module you are modifying.

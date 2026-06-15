# Running, Building & Deploying

**Purpose:** How to run, build, and deploy each part, including Docker and ACTION mode.

---

## Backend ([`fix-back/`](../../fix-back/)) — scripts ([package.json](../../fix-back/package.json))

| Command | What it does |
|---------|--------------|
| `npm run start` | `nest start` (NORMAL mode, no watch) |
| `npm run start:dev` | `nest start --watch` → http://localhost:3000 |
| `npm run start:debug` | watch + debugger |
| `npm run build` | `nest build` → `dist/` |
| `npm run start:prod` | `node dist/main` |
| `npm run action:detect-stagnant-di` | `ACTION=DETECT_STAGNANT_DI ts-node … src/main.ts` (no HTTP server) |
| `npm run action:sync-google-sheets` | `ACTION=SYNC_GOOGLE_SHEETS ts-node … src/main.ts` |
| `npm run lint` / `npm run format` | ESLint `--fix` / Prettier |
| `npm run test*` | see [conventions/02-testing.md](../conventions/02-testing.md) |

### Two runtime modes ([`main.ts`](../../fix-back/src/main.ts))
- **NORMAL** (no `ACTION` env): starts HTTP + GraphQL + WebSocket on **:3000**, enables CORS, sets body-parser limit to **5gb** (for base64 file uploads).
- **ACTION** (`ACTION=…`): boots a minimal app context (no HTTP), runs `AppCronService.runAction(action)`, then exits. Used for stagnation detection and Sheets sync; ideal for cron/cloud-function triggers. See [modules/backend-cron-and-actions.md](../modules/backend-cron-and-actions.md).

## Frontend ([`fix-front/`](../../fix-front/)) — scripts ([package.json](../../fix-front/package.json))

| Command | What it does |
|---------|--------------|
| `npm start` | `ng serve` → http://localhost:4200 |
| `npm run build` | `ng build` → `dist/` (prod build swaps in `environment.prod.ts`) |
| `npm run test` | `ng test` (Karma) |
| `npm run lint` | `ng lint` |

For a LAN-served dev build the prod env expects `--host 192.168.1.29 --port 4200` (noted in [environment.prod.ts](../../fix-front/src/environments/environment.prod.ts)).

---

## Docker

Both Dockerfiles are **dev-only** (no baked production build; source is volume-mounted, container idles). All compose files attach to an **external** network `hostglobal`:
```bash
docker network create hostglobal     # one-time, required by all compose files
```

| Service | Compose file | Container | Ports | Notes |
|---------|--------------|-----------|-------|-------|
| MongoDB | [`fix-back/docker-compose-mongo.yml`](../../fix-back/docker-compose-mongo.yml) | `mongodb-fixtronix` | 27017 | `mongo:6.0`, data → `./database`, init script `./mongo-init.js` (not committed) |
| Backend | [`fix-back/docker-compose-fixtronix.yml`](../../fix-back/docker-compose-fixtronix.yml) | `fixtronix-backend` | 3000 | image `node-fixtronix-backend`, `env_file: .env`, source mounted at `/app`, command `tail -f /dev/null` (you `exec` in to run npm scripts) |
| Frontend | [`fix-front/docker.compose.yml`](../../fix-front/docker.compose.yml) | `node-fixtronix` | 4200 | source mounted at `/app` |

Because the backend container just idles, you typically `docker exec -it fixtronix-backend sh` then `npm install && npm run start:dev` inside it.

---

## Deployment shape (current)
- Appears to be an **on-prem / LAN deployment**: the frontend production environment targets `http://192.168.1.29:3000` (a private IP). There is no cloud build pipeline in-repo.
- The backend's MongoDB connection is hardcoded to `localhost:27017` with **no auth**; a MongoDB Atlas URI is present but **commented out** in [`app.module.ts`](../../fix-back/src/app.module.ts) — switching to Atlas (or any prod DB) is a code edit, not config.
- GraphQL Playground is **enabled** (`playground: true`) — including in production builds. Disable before any public exposure.

> ⚠️ Before deploying beyond a trusted LAN, resolve the items in [decisions/01-known-issues.md](../decisions/01-known-issues.md) (hardcoded secrets, open DB, unguarded API, public static files, 5gb body limit, Playground on).

---

## Logs
- Backend writes a `backend.log`; frontend a `frontend.log` (both git-ignored). Operational errors are appended under `logs/YYYY-MM/errors-YYYY-MM-DD.log` ([operational-error.service.ts](../../fix-back/src/operational-error/operational-error.service.ts)).

---

## Related files
- [01-setup.md](01-setup.md), [03-environment.md](03-environment.md)
- [modules/backend-cron-and-actions.md](../modules/backend-cron-and-actions.md)

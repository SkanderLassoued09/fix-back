# Local Setup (from a clean clone)

**Purpose:** Get both apps running locally from scratch.

---

## Prerequisites
- **Node.js 20** (backend Docker image is `node:20-alpine`; frontend Angular 17 supports Node 18/20).
- **npm** (frontend lockfile is npm; backend has `package-lock.json`). *(The frontend Dockerfile installs `pnpm`, but the committed lockfile is `package-lock.json` — use npm to match it.)*
- **MongoDB 6** running locally on `localhost:27017` (Docker or native). No auth is configured.
- Optional: **Docker** + Docker Compose if you prefer containers.

---

## 1. Clone (two separate repos)
```bash
git clone https://github.com/SkanderLassoued09/fix-back.git
git clone https://github.com/SkanderLassoued09/fix-front.git
# place them side by side, e.g. under a "fixtronix erp/" folder
```

## 2. Start MongoDB
Native, or via the provided compose (requires the `hostglobal` network first):
```bash
docker network create hostglobal           # one-time
cd fix-back
docker compose -f docker-compose-mongo.yml up -d   # mongo:6.0 on :27017, data → ./database
```
The backend connects to `mongodb://localhost:27017/fixtronix` (hardcoded in [`app.module.ts`](../../fix-back/src/app.module.ts)). The DB/collection are created on first write.

> ⚠️ There is **no `mongo-init.js` seed in the repo** (the mongo compose references it as a volume but the file isn't committed). You'll start with an **empty database** — see "First user" below.

## 3. Backend
```bash
cd fix-back
npm install
# create .env (see operations/03-environment.md) — at minimum it can be empty for NORMAL mode,
# but Google Sheets / ACTION features need their vars.
npm run start:dev          # NestJS watch mode → http://localhost:3000
```
GraphQL Playground: `http://localhost:3000/graphql`.

## 4. Frontend
```bash
cd fix-front
npm install
npm start                  # ng serve → http://localhost:4200
```
Dev env points at `http://localhost:3000/` ([environment.ts](../../fix-front/src/environments/environment.ts)).

## 5. First user (bootstrapping auth)
There's no seed and no public sign-up. To log in you need a `Profile` document with a **bcrypt-hashed** password and a valid `role`. Options:
- Run the `createProfile` mutation via GraphQL Playground (the profile schema bcrypt-hashes the password on save — pass a plaintext password). Use a role from `ADMIN_MANAGER | ADMIN_TECH | MANAGER | TECH | MAGASIN | COORDINATOR`.
- Or insert directly into Mongo with a pre-hashed password.

> Confirm the exact `createProfile` input shape in [`profile/dto/`](../../fix-back/src/profile/dto/) before running it. (Logged as an open question — there's no documented seed flow.)

---

## Common pitfalls
- **No `.env.example`** — you must discover env vars from code; the canonical list is in [03-environment.md](03-environment.md).
- **Mongo must be up before the backend** — `MongooseModule.forRoot` connects at boot.
- **Empty DB** means empty dropdowns (clients, locations, categories, tarif). Seed reference data via the respective `create*` mutations.
- **Ports:** backend 3000, frontend 4200, Mongo 27017 must be free.

---

## Related files
- [02-running.md](02-running.md), [03-environment.md](03-environment.md)
- [`fix-back/README.md`](../../fix-back/README.md) (generic NestJS starter readme)

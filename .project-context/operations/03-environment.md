# Environment & Configuration

**Purpose:** The authoritative list of environment variables, secrets, and config — discovered by grepping the source (there is **no `.env.example`** in the repo).

---

## Backend env vars (`fix-back/.env`)

Loaded by `import 'dotenv/config'` at the top of [`main.ts`](../../fix-back/src/main.ts). Every variable actually referenced in `src/`:

| Variable | Used by | Required for | Notes |
|----------|---------|--------------|-------|
| `ACTION` | [main.ts](../../fix-back/src/main.ts) | ACTION mode only | e.g. `DETECT_STAGNANT_DI`, `SYNC_GOOGLE_SHEETS`. Unset = NORMAL server. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | [google-sheets.client.ts:39](../../fix-back/src/google-sheets/google-sheets.client.ts#L39) | Google Sheets sync | Service-account email |
| `GOOGLE_PRIVATE_KEY` | [google-sheets.client.ts:43](../../fix-back/src/google-sheets/google-sheets.client.ts#L43) | Google Sheets sync | Service-account private key (PEM; usually needs `\n` un-escaping) |
| `GOOGLE_SHEETS_ID` | [google-sheets.client.ts:79](../../fix-back/src/google-sheets/google-sheets.client.ts#L79) | Google Sheets sync | Target workbook id |
| `GOOGLE_SHEETS_TAB` | [di-sheet.mapper.ts:43](../../fix-back/src/google-sheets/mappers/di-sheet.mapper.ts#L43) | Google Sheets sync | DI tab name / range |
| `GOOGLE_SHEETS_STATS_TAB` | [stats-sheet.mapper.ts:29](../../fix-back/src/google-sheets/mappers/stats-sheet.mapper.ts#L29) | Google Sheets sync | Stats tab name / range |

That's the **complete** set of `process.env.*` references in the backend. The Docker backend service loads them via `env_file: .env`.

### Config that is hardcoded (should be env, currently isn't)
These are real configuration values baked into source — treat as **tech debt / security risk** ([decisions/01-known-issues.md](../decisions/01-known-issues.md)):

| Setting | Hardcoded value / location | Should be |
|---------|---------------------------|-----------|
| JWT signing secret | `'hide-me'` in [jwt.strategy.ts:12](../../fix-back/src/auth/jwt.strategy.ts#L12) | `JWT_SECRET` env |
| Discord webhook URL | full URL in [discord-hook.service.ts:47](../../fix-back/src/discord-hook/discord-hook.service.ts#L47) (code even references `DISCORD_WEBHOOK_URL` in an error) | `DISCORD_WEBHOOK_URL` env, **rotate the leaked one** |
| MongoDB URI | `mongodb://localhost:27017/fixtronix` in [app.module.ts:36](../../fix-back/src/app.module.ts#L36) (Atlas URI commented above it) | `MONGO_URI` env |
| HTTP port | `3000` in [main.ts:53](../../fix-back/src/main.ts#L53) | `PORT` env |
| Body-parser limit | `5gb` in [main.ts:50](../../fix-back/src/main.ts#L50) | configurable / lower |

---

## Frontend config (`fix-front/src/environments/`)

No `.env`; config is compiled in. `ng build` swaps `environment.ts` → `environment.prod.ts` (via `angular.json` fileReplacements).

| Field | [environment.ts](../../fix-front/src/environments/environment.ts) (dev) | [environment.prod.ts](../../fix-front/src/environments/environment.prod.ts) (prod) |
|-------|------|------|
| `production` | `false` | `true` |
| `apiUrl` | `http://localhost:3000/` (trailing `/`) | `http://192.168.1.29:3000` (no `/`) |
| `host` | `http://localhost:4200` | `http://192.168.1.29:4200` |

> ⚠️ The dev `apiUrl` has a **trailing slash** and prod does not — [`graphql.modules.ts`](../../fix-front/src/app/graphql.modules.ts) builds `${apiUrl}graphql`, so the slash handling is load-bearing (there's a code comment about it). The WS URL is derived by `apiUrl.replace('http','ws')`. Hardcoded LAN IP `192.168.1.29` must be changed per deployment.

---

## Secrets handling — current state
- There is **no secrets manager**. The only `.env`-based secrets are the Google service-account vars; the JWT secret and Discord webhook are in source.
- `.env` is git-ignored, but the in-source secrets are **already in git history** — rotating them requires also scrubbing/rotating, not just moving to `.env`.

---

## Related files
- [01-setup.md](01-setup.md), [02-running.md](02-running.md)
- [architecture/04-integrations.md](../architecture/04-integrations.md), [decisions/01-known-issues.md](../decisions/01-known-issues.md)

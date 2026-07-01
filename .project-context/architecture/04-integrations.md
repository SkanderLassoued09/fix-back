# Integrations

**Purpose:** Document the external services and real-time channels the backend integrates with, and exactly how each is wired.

---

## Summary

| Integration | Direction | Transport | Auth | Code |
|-------------|-----------|-----------|------|------|
| MongoDB | read/write | Mongoose | none (no DB auth) | [app.module.ts](../../fix-back/src/app.module.ts) |
| Google Sheets | push (append) | `googleapis` Sheets v4 | **OAuth 2.0** — shared Gmail grant (see [google-auth/](../../fix-back/src/google-auth/)) | [google-sheets/](../../fix-back/src/google-sheets/) |
| Google Drive | push (create folder/upload) | `googleapis` Drive v3 | **OAuth 2.0** — same shared Gmail grant | [google-drive/](../../fix-back/src/google-drive/) |
| Discord | push (notify) | HTTPS webhook (`axios`) | webhook URL (**hardcoded**) | [discord-hook/discord-hook.service.ts](../../fix-back/src/discord-hook/discord-hook.service.ts) |
| Jira Cloud | push (create issue) | HTTPS REST v3 (`axios`) | Basic (email + API token) | [jira/jira.service.ts](../../fix-back/src/jira/jira.service.ts) |
| Socket.io | push (front) | WebSocket | none | [notification.gateway.ts](../../fix-back/src/notification.gateway.ts) |
| GraphQL subscriptions | push (front) | WebSocket (`graphql-ws` subprotocol) | none (no JWT on WS) | [pubsub/](../../fix-back/src/pubsub/), resolvers |

---

## Google Sheets (daily export)

Appends new/changed DIs and a daily KPI snapshot to a Google Sheets workbook.

- **Auth:** **OAuth 2.0** — the SHARED Gmail grant (same account as Drive), via `GoogleOAuthService` ([google-auth.service.ts](../../fix-back/src/google-auth/google-auth.service.ts)). Reads `GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`; the consent requests the combined scopes `drive.file` **+** `spreadsheets` on one refresh token. The Gmail account **owns** the workbook, so no service-account sharing is needed. *(Migrated off the service account 2026-07-01 — adding the `spreadsheets` scope requires a one-time re-consent to mint a token covering Drive + Sheets; a Sheets 403 raises a clear re-consent error.)*
- **Target:** workbook `GOOGLE_SHEETS_ID`; tabs `GOOGLE_SHEETS_TAB` (DI rows) and `GOOGLE_SHEETS_STATS_TAB` (stats snapshot).
- **Architecture:**
  - `SheetSyncService.syncAllEntities()` iterates a list of `IGoogleSheetMapper`s with per-mapper try/catch isolation.
  - `DiSheetMapper` — 21-column export of DIs updated in the last 24h (incremental by date window; no sync-state table).
  - `StatsSheetMapper` — one aggregated KPI row per run (created/closed/in-progress/paused counts).
- **Triggers:** `SheetSyncScheduler` (`@Cron(EVERY_DAY_AT_2AM)`) **and** `ACTION=SYNC_GOOGLE_SHEETS`. Both call the same service.

Details: [backend-cron-and-actions.md](../modules/backend-cron-and-actions.md).

---

## Google Drive (auto client folder on company creation)

On `createCompany`, auto-creates a Drive folder `{raisonSociale} {DD/MM/YYYY HH:mm:ss}`
(timezone `Africa/Tunis`) and stores `driveFolderId`/`driveFolderUrl` on the company.

- **Auth:** **OAuth 2.0** as a real Gmail account (the one owning the storage quota), via the shared `GoogleOAuthService` ([google-auth.service.ts](../../fix-back/src/google-auth/google-auth.service.ts)) — **NOT** a service account. Same refresh token as Sheets (scope `drive.file`).
- **No Shared Drive required:** files are owned by (and billed to) the consenting account's own Drive; `supportsAllDrives: true` is kept for forward-compat if the account later moves to Workspace. (Historical: a service account was used first — it has no personal quota, which is exactly why the project moved to OAuth-as-real-account.)
- **Best-effort:** Drive failure never blocks company creation (`driveFolderId` stays null).
- **Idempotent:** by `driveFolderId` (the name is unique per second — no name-based dedup).
- **Repair:** `ensureClientFolder(companyId)` mutation recreates the folder when missing.
- **Config:** `GOOGLE_DRIVE_PARENT_FOLDER_ID`, `GOOGLE_DRIVE_ID`, `DRIVE_FOLDER_DATE_FORMAT`,
  `APP_TIMEZONE`. Disabled (inert) until `GOOGLE_DRIVE_PARENT_FOLDER_ID` is set.

Decision + external prerequisites: [decisions/04-google-drive-client-folders.md](../decisions/04-google-drive-client-folders.md).

---

## Discord (operational alerts)

Posts structured operational errors and key events to a Discord channel via webhook.

- **Code:** [discord-hook.service.ts](../../fix-back/src/discord-hook/discord-hook.service.ts) — many `axios.post(this.webhookUrl, …)` helpers for different event shapes.
- ⚠️ **The webhook URL is hardcoded in source** (`discord-hook.service.ts:47-48`) — a real, live secret committed to the repo. The error message at line 186 references `DISCORD_WEBHOOK_URL`, implying it was *meant* to come from env. See [known-issues](../decisions/01-known-issues.md). Move it to an env var and rotate the webhook.
- **Callers:** `OperationalErrorService.capture()` (best-effort) and `AlertsService` (stagnation alert broadcast). All Discord calls are **best-effort** — a webhook failure never fails the originating operation.

---

## Jira Cloud (meeting actions → issues)

On `createReunionPV`, every **"Action à mener"** of the meeting is mirrored into a Jira issue in the configured project — the realization of the `actions[].jira` sub-doc that was scaffolded on the entity.

- **Code:** [jira.service.ts](../../fix-back/src/jira/jira.service.ts), called from [reunion-pv.service.ts](../../fix-back/src/reunion-pv/reunion-pv.service.ts) `syncActionsToJira` **after the PV is persisted** (same best-effort site as Discord).
- **Auth:** HTTP Basic — `JIRA_EMAIL` + `JIRA_API_TOKEN` (base64). Endpoint `POST {JIRA_BASE_URL}/rest/api/3/issue`, **ADF** description.
- **Mapping:** `titre→summary`, `description→description` (ADF), `priorite→priority` (BASSE/MOYENNE/HAUTE → Low/Medium/High), `echeance→duedate`, `responsable→assignee` (best-effort `accountId` lookup by the Profile's email), meeting `reference`+`_id` embedded in the description. On success writes back `actions[].jira { synced, issueKey, url }`.
- **Resilience:** a 400 (optional fields not on the project's create screen) triggers one retry with a minimal payload so the action still lands.
- **Best-effort:** never blocks PV creation; per-issue failures captured via `OperationalErrorService` (severity LOW). **Inert** until `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN`/`JIRA_PROJECT_KEY` are set; **skipped** on `x-test-run` traffic.
- **Config:** the four required vars above (+ optional `JIRA_API_VERSION`=3, `JIRA_TIMEOUT`=10000, `JIRA_ISSUE_TYPE`=Task). See [operations/03-environment.md](../operations/03-environment.md).

---

## Socket.io push notifications (Channel A)

`NotificationsGateway` ([notification.gateway.ts](../../fix-back/src/notification.gateway.ts), `@WebSocketGateway({ cors: true })`) emits these events to all connected clients:

| Method | Event name emitted |
|--------|--------------------|
| `sendReminder` | `reminder` |
| `sendNotificationDiag` | `sendDitoDiagnostique` |
| `sendNotifcationToAdmins` | `sendNotifcationToAdmins` *(sic)* |
| `confirmComposant` | `confirmAllComposant` |
| `blAddedNotification` | `blAddedNotification` |
| `sendComponentToCoordinatorFromMagasin` | `component:sent_to_coordinator` |
| `sendComponentToMagasinFromCoordinator` | `component:confirmed_by_coordinator` |
| `updateTicket` | `updateTicket` |
| `alertCreated` | `alert.created` |
| `alertResolved` | `alert.resolved` |

The frontend Web Worker ([notification.worker.ts](../../fix-front/src/app/demo/service/notification.worker.ts)) subscribes to these and forwards them to `notification.service.ts` subjects. See [frontend-services-and-apollo.md](../modules/frontend-services-and-apollo.md).

---

## GraphQL subscriptions (Channel B)

Enabled by `installSubscriptionHandlers: true` ([app.module.ts](../../fix-back/src/app.module.ts)) — this uses Apollo Server 3's **legacy `subscriptions-transport-ws`** protocol. A shared `PubSub` ([pubsub.module.ts](../../fix-back/src/pubsub/pubsub.module.ts)) backs these topics:

| Subscription | Topic | Resolver |
|--------------|-------|----------|
| `notificationConfirmation` | `confirmation-composant` | [di.resolver.ts:170](../../fix-back/src/di/di.resolver.ts#L170) |
| `notificationDiagnostic` | `you-got-notification-diagnostic` | `stat.resolver.ts` |
| `notificationReparation` | `you-got-notification-reparation` | `stat.resolver.ts` |

The frontend implements its **own** WebSocket link by hand ([graphql.modules.ts:40](../../fix-front/src/app/graphql.modules.ts#L40)) — it opens `ws://…/graphql` with subprotocol `graphql-ws` but speaks the legacy message shapes (`connection_init`, `start`, `data`, `complete`, `error`). ⚠️ The subprotocol *string* `graphql-ws` does not match the modern graphql-ws library protocol; it matches what apollo-server-express 3 expects. The JWT is **not** sent over this socket.

---

## Related files
- [`fix-back/src/google-sheets/`](../../fix-back/src/google-sheets/), [`fix-back/src/discord-hook/`](../../fix-back/src/discord-hook/)
- [02-data-flow.md](02-data-flow.md), [backend-realtime-notifications.md](../modules/backend-realtime-notifications.md)
- [operations/03-environment.md](../operations/03-environment.md) — the env vars these need

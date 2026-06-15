# Module: Backend — Real-time & Notifications

**Purpose:** Document the two real-time channels (Socket.io gateway and GraphQL subscriptions), the audit/notification inbox, and the alerts module.

---

## Responsibility

Push state changes to connected clients so each role sees fresh data without manual refresh, and persist notifications/alerts. There are **two parallel mechanisms** — they are not unified.

---

## Channel A — Socket.io gateway

[`notification.gateway.ts`](../../fix-back/src/notification.gateway.ts) — `NotificationsGateway` (`@WebSocketGateway({ cors: true })`). It is **provided/used by services**, which call its emit helpers. Connection/disconnect handlers are no-ops (logging commented out). Events emitted (full list in [architecture/04-integrations.md](../architecture/04-integrations.md)):

`reminder`, `sendDitoDiagnostique`, `sendNotifcationToAdmins`, `confirmAllComposant`, `blAddedNotification`, `component:sent_to_coordinator`, `component:confirmed_by_coordinator`, `updateTicket`, `alert.created`, `alert.resolved`.

`updateTicket` carries `{ action, content, target? }` where `target` is typically a profile — the frontend filters by it.

> ⚠️ The gateway broadcasts with `server.emit(...)` — **no rooms / per-user targeting** on the server side. Every client receives every event and filters client-side.

## Channel B — GraphQL subscriptions

[`pubsub/pubsub.module.ts`](../../fix-back/src/pubsub/pubsub.module.ts) exports a shared `graphql-subscriptions` `PubSub`. Resolvers publish to topics and expose `@Subscription` fields:

| Topic | Subscription field | Where |
|-------|--------------------|-------|
| `confirmation-composant` | `notificationConfirmation` | [di.resolver.ts:153-173](../../fix-back/src/di/di.resolver.ts#L153) |
| `you-got-notification-diagnostic` | `notificationDiagnostic` | `stat.resolver.ts` |
| `you-got-notification-reparation` | `notificationReparation` | `stat.resolver.ts` |

Enabled via `installSubscriptionHandlers: true` (Apollo Server 3 legacy WS). See protocol notes in [architecture/04-integrations.md](../architecture/04-integrations.md).

---

## Audit (`audit/`) — notification inbox

[`audit/`](../../fix-back/src/audit/) stores persistent notifications / audit records.

- **Entity:** `{ _idDoc, message, type, isSeen, createdAt }`.
- **Resolver:** `createAudit`, `markAsSeenNotification`, `removeAudit`; queries `getAllNotification`, `findOne`.
- **Maintenance:** `AuditService.emptyAudit()` runs on a cron (`EVERY_10_HOURS`) to purge.
- Also has reminder helpers (`findExistingReminders`) used by the (currently disabled) reminder cron path in [cron.service.ts](../../fix-back/src/cron/cron.service.ts).

## Alerts (`alerts/`) — persistent operational alerts

[`alerts/`](../../fix-back/src/alerts/) backs the stagnation/operational alert system (survives refresh & restart).

- **Entity `DiAlert`:** `{ diId, type (AlertType enum: DI_STAGNANT_24H/72H/7D…), severity (INFO/WARNING/CRITICAL), message, assignedRoles[], metadata, escalationLevel, resolvedAt, resolvedBy }` ([alert.enums.ts](../../fix-back/src/alerts/alert.enums.ts), [di-alert.entity.ts](../../fix-back/src/alerts/entities/di-alert.entity.ts)).
- **Resolver:** query `listDiAlerts(filter)`; mutation `resolveDiAlert(id, resolvedBy)`.
- **Service:** `createAlertIfMissing` dedupes by `{ diId, type, open }`; on escalation it resolves lower-tier alerts. Broadcasts `alert.created` / `alert.resolved` over the Socket.io gateway (best-effort Discord too).
- **Producer:** the stagnation detector (see [backend-cron-and-actions.md](backend-cron-and-actions.md)).

---

## Frontend consumption (for context)

The frontend does **not** use the Socket.io gateway directly on the main thread — it runs `socket.io-client` inside a Web Worker ([notification.worker.ts](../../fix-front/src/app/demo/service/notification.worker.ts)) and bridges events to RxJS subjects in [notification.service.ts](../../fix-front/src/app/demo/service/notification.service.ts). Components subscribe and re-query (debounced via [ticket-refresh.service.ts](../../fix-front/src/app/demo/service/ticket-refresh.service.ts)). Details: [frontend-services-and-apollo.md](frontend-services-and-apollo.md).

---

## Related files
- [architecture/04-integrations.md](../architecture/04-integrations.md), [architecture/02-data-flow.md](../architecture/02-data-flow.md)
- [backend-cron-and-actions.md](backend-cron-and-actions.md) — alert producer

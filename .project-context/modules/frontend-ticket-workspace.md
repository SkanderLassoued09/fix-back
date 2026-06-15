# Module: Frontend — Ticket Workspace (DI UI)

**Purpose:** Document the DI ticket UI — the role-specific list views and the diagnostic/repair modals. This is the largest and most important frontend area.

---

## Location & structure

[`fix-front/src/app/demo/components/ticket/`](../../fix-front/src/app/demo/components/ticket/). Lazy-loaded under route `/tickets` ([app-routing.module.ts](../../fix-front/src/app/app-routing.module.ts)).

```
ticket/
├── ticket.module.ts / ticket-routing.module.ts
├── ticket_status_severity.ts        # status → PrimeNG severity (badge color)
├── table-display.utils.ts           # table formatting helpers
├── _tech-workflow-cards.scss        # shared card styles
├── add-ticket/                      # create-DI form
├── composant-management/            # parts CRUD UI
└── ticket-list/
    ├── ticket-list.component.ts      # MANAGER/ADMIN view: ALL DIs (~very large)
    ├── constant-queries.ts           # shared gql constants (e.g. ALL_USERS)
    ├── tech-di-list/                 # TECH diagnostic queue
    │   └── diagnostic-modal/
    │       ├── components/  (header, info-strip, sidebar, stepper, timer)
    │       └── steps/       (info, components, failure, validation, summary)
    ├── tech-repair-list/             # TECH repair queue
    │   └── repair-modal/
    │       └── steps/       (info, parts, plan, works, summary)
    ├── coordinator-di-list/          # COORDINATOR routing queue
    └── magasin-di-list/              # MAGASIN parts queue
        └── details-composant/        # component detail view
```

---

## Role → list-view mapping

The menu sends each role to a different list ([app.menu.component.ts](../../fix-front/src/app/layout/app.menu.component.ts)):

| Role | Route | Component | What it does |
|------|-------|-----------|--------------|
| MANAGER / ADMIN_* | `/tickets/ticket/ticket-list` | `ticket-list` | All DIs; create/update/delete; upload docs; pricing/negotiation actions; close |
| TECH | `/tickets/ticket/tech-di-list` | `tech-di-list` | Diagnostic queue; runs the diagnostic modal & timer |
| TECH (repair) | (within tech views) | `tech-repair-list` | Repair queue; runs the repair modal & timer |
| COORDINATOR | `/tickets/ticket/coordinator-di-list` | `coordinator-di-list` | Routes DIs: to diagnostic, to magasin, to repair |
| MAGASIN | `/tickets/ticket/magasin-di-list` | `magasin-di-list` | Estimates/sources parts (PDR); confirms components |

Each list maps onto the DI workflow stage owned by that role (see [overview/01-purpose.md](../overview/01-purpose.md) for the lifecycle).

---

## Diagnostic & repair modals (stepper UX)

Both modals are multi-step wizards with a live **timer** (the technician's tracked time is what feeds `Stat.diag_time` / `rep_time`).

- **Diagnostic modal** steps: info → components (only shown when `contain_pdr === true`) → failure → validation → summary. Decides `can_be_repaired`, `contain_pdr`, `di_category_id`, and `array_composants`.
- **Repair modal** steps: info → parts → plan → works → summary.

### Repair timer is server-anchored (survives refresh) — 2026-06-10
The repair modal's timer is **derived from persisted data, not an in-memory counter**, so it survives a page refresh / new tab / other device:
- **Model:** `elapsed = rep_time + (status === INREPARATION ? now − repRunStartedAt : 0)`, frozen at `rep_time` while `REPARATION_Pause`.
- **`Stat.repRunStartedAt`** (Date) is the run-leg anchor, stamped server-side in `changeStatusInRepair` **only when `previousStatus !== INREPARATION`** (a true start/resume) — never on the open no-op or on pause. So refreshing while running keeps the original start instead of re-anchoring to "now".
- `repModal()` seeds the modal inputs (`elapsedBaseMs`/`runStartedAtMs`) from the row's `rep_time` + `repRunStartedAt` + `status`. On pause, the host folds the live run leg into `rep_time` and persists it; on resume it re-anchors `repRunStartedAt = now`.
- The same-device convenience auto-restore (`persistActiveDialogState`/`restoreDialogState` via `localStorage`) is kept **status-consistent**: pause persists the snapshot in its paused form so a refresh reopens **frozen** (not auto-resumed); resume mirrors the new anchor onto `this.di` so it doesn't double-count. **localStorage is never the timer's source of truth** — the server fields are.
- **Diagnostic modal timer is the reference pattern and was left untouched.**

These modals were progressively unified (the TODO log shows "Apply modal of Diagnostic in Create DI / Reparation / Pricing / Negotiation"). The modal `components/` and `steps/` are split into small standalone files with their own `.types.ts`.

---

## How the UI talks to the backend
- Components call services in [`demo/service/`](../../fix-front/src/app/demo/service/) (mainly `ticket.service.ts`) which return `gql` documents; the component runs them via Apollo with `fetchPolicy: 'no-cache'`.
- After a Socket.io event arrives (via `notification.service.ts`), the list re-queries — debounced through `ticket-refresh.service.ts`. See [frontend-services-and-apollo.md](frontend-services-and-apollo.md).

---

## Conventions in this area
- **Module-per-feature** with co-located `*-routing.module.ts`, `*.component.{ts,html,scss,spec.ts}`, and `*.interface(s).ts` (naming inconsistent: `tech-di-list.interface.ts` vs `coordinator-di-list.interfaces.ts`).
- Status badge colors centralized in `ticket_status_severity.ts`; magasin component statuses in `magasin-di-list/status-composants.ts`.
- Some component files are **very large** (`ticket-list` and `tech-di-list` are the biggest in the app) and hold most of the GraphQL strings inline.

---

## Related files
- [backend-di-domain.md](backend-di-domain.md) — the API behind every action here
- [frontend-services-and-apollo.md](frontend-services-and-apollo.md) — the services these call
- [`fix-front/src/To_do_Folder/Fixtronix_issues.todo`](../../fix-front/src/To_do_Folder/Fixtronix_issues.todo) — feature history for this area

---

_Last updated: 2026-06-10 (repair timer made server-anchored so it survives refresh)._

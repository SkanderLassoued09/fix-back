# Fixtronix ERP — Project Knowledge Base

**Purpose:** Single source of truth for the Fixtronix ERP codebase — read this folder before doing any work so a new engineer (or a fresh Claude session) can become productive without re-reading the whole repo.

**Last updated: 2026-06-10**

---

## What this is

Fixtronix ERP is a full-stack **repair-management** system (French: *Demande d'Intervention*, abbreviated **DI**). It tracks repair tickets from creation through diagnostic, parts procurement, pricing/negotiation, repair, and return — with a distinct UI and permission set for each staff role.

The repository root (`fixtronix erp/`) is **not** a git repo. It contains two **independent** git projects:

| Folder | Project | Stack | Port | Git remote |
|--------|---------|-------|------|------------|
| [`fix-back/`](../fix-back/) | Backend API | NestJS 9 + GraphQL + MongoDB | 3000 | `github.com/SkanderLassoued09/fix-back` |
| [`fix-front/`](../fix-front/) | Frontend SPA | Angular 17 + PrimeNG (Sakai-NG) | 4200 | `github.com/SkanderLassoued09/fix-front` |

There is also a root [`AGENTS.md`](../AGENTS.md) (an older agent guide). This `.project-context/` folder supersedes it as the authoritative reference; where they disagree, trust this folder (it was verified against the actual code on the date above).

---

## How to use this folder

1. **Start here**, then read `overview/` for the domain and stack.
2. Read `architecture/` for the big picture (components, data flow, data models, integrations).
3. Use `modules/` as a reference when touching a specific area.
4. Follow `conventions/` when writing code so your changes match the codebase.
5. Use `operations/` to set up, run, and configure the apps.
6. Check `decisions/01-known-issues.md` **before** trusting any subsystem — several areas are fragile or insecure. `decisions/02-open-questions.md` lists what still needs a human answer.

> **Grounding rule:** every claim here cites a file path. If you change the code, update the relevant doc and the "Last updated" date above.

---

## Index

### overview/
| File | What it covers |
|------|----------------|
| [01-purpose.md](overview/01-purpose.md) | What the product does, who it's for, the DI lifecycle and roles |
| [02-glossary.md](overview/02-glossary.md) | Domain terms (DI, Magasin, Retour, PDR…) and project vocabulary |
| [03-tech-stack.md](overview/03-tech-stack.md) | Languages, frameworks, libraries and versions, both sides |

### architecture/
| File | What it covers |
|------|----------------|
| [01-system-overview.md](architecture/01-system-overview.md) | High-level component diagram + responsibilities |
| [02-data-flow.md](architecture/02-data-flow.md) | Request/response, auth, real-time, file upload, cron/action flows |
| [03-data-models.md](architecture/03-data-models.md) | MongoDB collections, entities, relationships, the DI status model |
| [04-integrations.md](architecture/04-integrations.md) | Google Sheets, Discord, Socket.io, GraphQL subscriptions |

### modules/
| File | What it covers |
|------|----------------|
| [backend-di-domain.md](modules/backend-di-domain.md) | Core DI ticket domain, workflow engine, Stat ledger, logs |
| [backend-auth.md](modules/backend-auth.md) | JWT/Passport auth, guards, roles |
| [backend-realtime-notifications.md](modules/backend-realtime-notifications.md) | Socket.io gateway, GraphQL PubSub, alerts |
| [backend-cron-and-actions.md](modules/backend-cron-and-actions.md) | Cron jobs, ACTION dispatcher, stagnation, Google Sheets sync, operational errors |
| [backend-dashboard-kpi.md](modules/backend-dashboard-kpi.md) | Dashboard KPIs and technician analytics |
| [backend-supporting-modules.md](modules/backend-supporting-modules.md) | Clients, company, composant, location, tarif, remarque, profile, etc. |
| [frontend-ticket-workspace.md](modules/frontend-ticket-workspace.md) | The DI ticket UI: role lists, diagnostic/repair modals |
| [frontend-services-and-apollo.md](modules/frontend-services-and-apollo.md) | Apollo setup, GraphQL services, notifications, refresh bus |
| [frontend-shell-auth-dashboard.md](modules/frontend-shell-auth-dashboard.md) | Layout shell, menu, auth/login, dashboard |

### conventions/
| File | What it covers |
|------|----------------|
| [01-code-style.md](conventions/01-code-style.md) | Naming, structure, patterns actually used |
| [02-testing.md](conventions/02-testing.md) | Test layout and how to run tests |
| [03-git-workflow.md](conventions/03-git-workflow.md) | Branches, commits, remotes, CI status |

### operations/
| File | What it covers |
|------|----------------|
| [01-setup.md](operations/01-setup.md) | Local setup from a clean clone |
| [02-running.md](operations/02-running.md) | Build / run / deploy each part, Docker |
| [03-environment.md](operations/03-environment.md) | Env vars, secrets, config |

### decisions/
| File | What it covers |
|------|----------------|
| [01-known-issues.md](decisions/01-known-issues.md) | Bugs, tech debt, security risks, fragile areas |
| [02-open-questions.md](decisions/02-open-questions.md) | Ambiguities needing a human answer |

---

## Related files
- [`AGENTS.md`](../AGENTS.md) — legacy agent guide (superseded by this folder)
- [`fix-back/src/app.module.ts`](../fix-back/src/app.module.ts) — backend module wiring
- [`fix-front/src/app/app.module.ts`](../fix-front/src/app/app.module.ts) — frontend root module

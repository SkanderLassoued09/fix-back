# Open Questions

**Purpose:** Things I could not determine from the code alone and that need a human answer. Each lists my best current inference so work isn't blocked — but **confirm before relying on these.**

---

## Environment & secrets
1. **Full `.env` contents for production.** Only 6 vars are referenced in code (`ACTION`, `GOOGLE_*`). Inference: nothing else is read from env today; JWT secret / Mongo URI / Discord URL are hardcoded. → *Should these be migrated to env, and what are the prod values?*
2. **Is MongoDB Atlas used in production?** A commented Atlas URI exists in [app.module.ts](../../fix-back/src/app.module.ts). Inference: prod still uses a local/LAN Mongo (no auth). → *Confirm the real prod database + whether auth should be enabled.*
3. **Google service-account credentials** — where do `GOOGLE_PRIVATE_KEY` / `GOOGLE_SERVICE_ACCOUNT_EMAIL` come from, and which workbook/tabs (`GOOGLE_SHEETS_ID`, `GOOGLE_SHEETS_TAB`, `GOOGLE_SHEETS_STATS_TAB`) are the live targets?

## Deployment
4. **What is the actual deployment target?** Prod env points at `192.168.1.29` (LAN). Inference: on-prem single-server LAN deployment, dev-only Docker images, manual `npm` inside containers. → *Is there a real prod host/process, or is `192.168.1.29` someone's machine?*
5. **How are the ACTION jobs scheduled in prod** (`DETECT_STAGNANT_DI`, `SYNC_GOOGLE_SHEETS`)? They can run via in-process `@Cron` (if the server stays up) or via `npm run action:*`. → *Which is used — in-process cron, OS cron, or a cloud scheduler?*

## Data & bootstrapping
6. **First-user / seed flow.** No `mongo-init.js` is committed and there's no seed script. → *How is the first admin profile created in a fresh environment?* (Inference: manual `createProfile` mutation or direct DB insert.)
7. **Reference data seeding** (locations, DI categories, composant categories, the single `tarif`). → *Is there an expected initial dataset?*

## Domain / workflow
8. **Is the DI workflow engine intended to fully replace the legacy per-edge mutations?** The map covers only 5 transitions with soft validation. → *Plan/priority for migrating the rest and flipping `strictFrom`/`strictRole` on?*
9. **Coordinator↔Magasin component handshake** — the DI fields (`handleSendingNotificationBetweenCoordinatorAndMagasin`, `isConfirmedComponentFromCoordinator`, `confirmationComposant`, `gotComposantFromMagasin`) encode a multi-step handshake. → *Is there a definitive spec for this sub-flow?* (Two TODO items remain open: "btn + time of confirmation composants Coordinator from magasin", "coordinator can send DI to repair".)
10. **`type_client` / `service_quality` / `CLIENT_TYPE`** — how are these classifications used downstream (pricing? reporting?)? Not obvious from the read code.

## Security posture
11. **Intended authorization model.** Should the backend enforce roles (via `RolesGuard`/`@Roles`) on resolvers, or is UI-only gating acceptable for the deployment context? This drives a large chunk of remediation in [01-known-issues.md](01-known-issues.md).
12. **Are the leaked secrets (JWT `'hide-me'`, Discord webhook) already rotated/known-compromised**, or do they need an urgent rotation?

## Testing / CI
13. **Is CI planned?** No pipeline exists; an `add-playwright-testing` branch suggests e2e is being added. → *What's the intended CI/test gate?*
14. **Should the stale backend e2e test (B1) be fixed or deleted?**

## Frontend cleanup
15. **Can the Sakai-NG demo modules** (`uikit`, `primeblocks`, `pages`, `landing`, `documentation`, `utilities`) and demo services be removed, or are any still referenced/needed?

---

## How to use this list
When you get an answer, update the relevant doc in this folder (and the README "Last updated" date), then remove or annotate the question here.

---

## Related files
- [01-known-issues.md](01-known-issues.md)
- [operations/03-environment.md](../operations/03-environment.md)

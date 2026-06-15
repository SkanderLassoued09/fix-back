# Glossary

**Purpose:** Define the domain terms and project-specific vocabulary (much of it French) used throughout the code and these docs.

---

## Domain terms

| Term | Meaning | Where it appears |
|------|---------|------------------|
| **DI** | *Demande d'Intervention* — the core repair ticket entity | `di/` module everywhere; `_idnum` is the human-facing DI number |
| **Magasin** | The stores / spare-parts department. The `MAGASIN` role estimates and sources parts | `magasin-di-list`, `STATUS_DI.InMagasin` |
| **Coordinator / Coordinatrice** | Dispatcher who routes DIs between diagnostic, magasin, and repair | `COORDINATOR` role, `coordinator-di-list` |
| **Tech / Technicien** | Performs diagnostic & repair, tracks time | `TECH` role, `tech-di-list`, `tech-repair-list` |
| **PDR** | *Pièce de rechange* — spare part. A DI "contains PDR" if it needs replacement parts | `contain_pdr` field, `Status PDR` Sheets column |
| **Composant** | Component / spare part (catalog item) | `composant/` module, `array_composants` on a DI |
| **Devis** | Quote / estimate (a PDF document) | `devis` field on DI |
| **Facture** | Invoice (a PDF document) | `facture` field |
| **Bon de commande (BC)** | Purchase order (a PDF document) | `bon_de_commande` field |
| **Bon de livraison (BL)** | Delivery note (a PDF document) | `bon_de_livraison` field |
| **Tarif** | Hourly labor rate used to compute technician cost | `tarif/` module |
| **Remarque** | A role-specific note/comment attached to a DI | `remarque/` module, `remarque_*` fields |
| **Retour** | A return (post-repair). Escalates RETOUR1 → RETOUR2 → RETOUR3 | `STATUS_DI.Retour1/2/3` |
| **Négociation (Nego1/Nego2)** | Price negotiation stages with discount tiers | `STATUS_DI.Negotiation1/2` |
| **Annuler** | Cancelled | `STATUS_DI.Annuler` |
| **Stagnation** | A DI stuck in one status too long (24h/72h/7d) | `stagnation/` module, `DiAlert` |
| **Stat** | A per-DI workflow ledger row (diag/repair times, pauses, assignments) | `stat/` module |
| **Location / Emplacement** | Physical storage location where a DI/board is kept | `location/` module |

---

## DI status values (string constants)

Defined in [`fix-back/src/di/di.status.ts`](../../fix-back/src/di/di.status.ts). The `status` field on a DI holds one of these raw strings:

| Constant key | `status` string | Meaning |
|--------------|-----------------|---------|
| Created | `CREATED` | Created by manager, not yet sent |
| Pending1 | `PENDING1` | Sent to diagnostic |
| Diagnostic | `DIAGNOSTIC` | Waiting for diagnostic |
| DiagnosticInPause | `DIAGNOSTIC_Pause` | Diagnostic paused |
| InDiagnostic | `INDIAGNOSTIC` | Diagnostic in progress |
| MagasinEstimation | `MagasinEstimation` | Magasin estimating before negotiation |
| InMagasin | `INMAGASIN` | In magasin |
| Pending2 | `PENDING2` | Sent to admins for pricing |
| Pricing | `PRICING` | Pricing in progress |
| Negotiation1 | `NEGOTIATION1` | Nego 0–20% discount or cancel (Manager) |
| Negotiation2 | `NEGOTIATION2` | Nego 20–25% discount / price change (Admin_Manager) |
| Pending3 | `PENDING3` | Sent to repair |
| Reparation | `REPARATION` | Waiting for repair |
| ReparationInPause | `REPARATION_Pause` | Repair paused |
| InReparation | `INREPARATION` | Repair in progress |
| Finished | `FINISHED` | DI process completed |
| Annuler | `ANNULER` | Cancelled |
| Retour1/2/3 | `RETOUR1` / `RETOUR2` / `RETOUR3` | Return escalation (RETOUR3 = general alert) |

> ⚠️ Status strings are **inconsistently cased**: most are upper-snake (`PENDING1`), but `MagasinEstimation` is PascalCase and `DIAGNOSTIC_Pause` / `REPARATION_Pause` mix cases. Always compare against the constants in `di.status.ts`, never hand-type the string.

---

## Project / tech vocabulary

| Term | Meaning |
|------|---------|
| **ACTION mode** | Backend run with `ACTION=…` env var to execute a one-off script instead of starting the HTTP server (see `main.ts`) |
| **Workflow engine** | The partial state-machine in `di/workflow/` that validates transitions (currently "soft" / non-blocking) |
| **Soft validation** | Workflow checks that only *warn* (log) instead of rejecting, during the legacy→engine migration |
| **Sakai-NG** | The PrimeNG Angular admin template the frontend is built on (`package.json` name is `sakai-ng`) |
| **`_idnum`** | Human-readable DI number (vs `_id`, the Mongo document id which is a string here, not an ObjectId) |
| **`ignoreCount`** | Counter for "je reviendrai" (I'll come back) — number of times a tech paused/re-opened, used to reconcile `Stat` rows |
| **FTR / First Time Right** | KPI: a DI closed with `ignoreCount === 0` (no re-work) |
| **TAT** | Turnaround time (createdAt → finished) KPI |
| **hostglobal** | External Docker network both compose files attach to |

---

## Related files
- [01-purpose.md](01-purpose.md) — how these terms fit the lifecycle
- [03-data-models.md](../architecture/03-data-models.md) — the entities behind these terms

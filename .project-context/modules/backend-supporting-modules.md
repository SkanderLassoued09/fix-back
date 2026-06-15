# Module: Backend — Supporting Modules

**Purpose:** Reference for the supporting CRUD / catalog modules that the DI domain depends on. Each follows the standard NestJS shape (`{feature}.module.ts` + `.resolver.ts` + `.service.ts` + `dto/` + `entities/`).

> Schemas for these entities are summarized in [architecture/03-data-models.md](../architecture/03-data-models.md). This file focuses on responsibilities and GraphQL operations.

---

## profile/ — users & roles
- **Responsibility:** user accounts (the `Profile` collection backing auth), technician availability, and technician cost/time reporting.
- **Entity:** `username, firstName, lastName, password(bcrypt), phone, role, email, isTechBusy, isDeleted`. `pre('save')` bcrypt-hashes the password.
- **Ops:** mutations `createProfile`, `updateProfile`, `deleteProfile`/`removeProfile`; queries `getTokenData` (current user, guarded), `getAllAdmins`, `getAllProfiles` (paginated), `searchProfile`, `findOne(username)`, `findOneForAuth` (used by auth), `getAllTech`, `getTicketByProfile` (computes tech cost from `Tarif` × times).
- Files: [`profile/`](../../fix-back/src/profile/). Central to [auth](backend-auth.md), stat, and dashboard.

## clients/ — individual customers
- `createClient`, `updateClient`, `removeClient`; `findOneClient`, `getAllClient`, `findAllClient` (paginated), `searchClient`. Entity: name/region/address/email/phone.

## company/ — business customers
- `createCompany`, `updateCompany`, `removeCompany`; `findOneCompany`, `getAllComapnyforDropDown` *(sic)*, `findAllCompany` (paginated), `searchCompany`, `searchCompanies`.
- Rich entity incl. fiscal fields (`mf`, `rne`, `raisonSociale`, `Exoneration`) and three contact sub-docs: `serviceFinancier`, `serviceAchat`, `serviceTechnique`.

## composant/ + composant_category/ — spare-parts catalog
- **composant:** `createComposant`, `updateComposant`, `updateComposantPartial`, `addComposantInfo`, `removeComposant`; queries `findOneComposant(name)`, `findAllComposant`, `searchComposants`. Stores `prix_achat`/`prix_vente`, `quantity_stocked`, a `pdf` (written to `docs/`), `status_composant`.
- **composant_category:** simple CRUD (`createComposant_Category`, `removeComposant_Category`, `findOne`, `findAll`).

## di_category/ — DI classification
- CRUD: `createDiCategory`, `removeDiCategory`, `findOneDiCategory`, `findAllDiCategory`. Entity: `{ category, isDeleted }`.

## location/ — storage locations
- CRUD: `createLocation`, `removeLocation`, `findOneLocation`, `findAllLocation`. Tracks capacity (`max_capacity`, `current_item_stored`, `storedDiCount`, `hasStoredDi`, `avaible` *(sic)*).

## tarif/ — hourly labor rate
- `createTarif`; query `getTarif`. Single-value entity `{ tarif: number }`. Used by profile/dashboard cost calculations.

## remarque/ — role notes
- `createRemarque`, `removeRemarque`; `findAll`, `findOne`. Stores the seven `remarque_*` fields per DI (also denormalized onto the DI document).

## stat/ — workflow ledger
- See [backend-di-domain.md](backend-di-domain.md). Exposes `searchTechDI`, `getDiForTech`, `getDiStatusCounts`, `getStatbyID`, `getInfoStatByIdDi`, `getRetourDataStats`, `checkDiStatConsistency`, plus mutations for assignment & pause logging and the diagnostic/repair **subscriptions**.

## logs-di/ — DI history
- See [backend-di-domain.md](backend-di-domain.md). `createLogsDi`, `tech_startDiagnosticLogs`, `updateLogsDi`, `removeLogsDi`; queries `findAll`, `getLigsById` *(sic)*, `getAllLogsByDi`.

## audit/ & alerts/ — notifications & alerts
- See [backend-realtime-notifications.md](backend-realtime-notifications.md).

## discord-hook/ — Discord webhook
- REST controller (`POST /discord-hook/test`, currently commented) + a service with many `axios.post` helpers. ⚠️ **Webhook URL hardcoded** in [discord-hook.service.ts:47](../../fix-back/src/discord-hook/discord-hook.service.ts#L47). See [architecture/04-integrations.md](../architecture/04-integrations.md).

## operational-error/, stagnation/, google-sheets/, cron/, pubsub/
- See [backend-cron-and-actions.md](backend-cron-and-actions.md) and [backend-realtime-notifications.md](backend-realtime-notifications.md).

---

## Cross-cutting conventions in these modules
- **Pagination** uses a `{ first, rows }` config + a `searchX` variant; list responses are `{ records[], totalCount }` shaped (e.g. `DiTableData`, `ProfileTableData`).
- **Soft delete** via `isDeleted`.
- **Module naming is inconsistent**: `ClientsModule`/`CompanysModule` (plural) vs `DiModule`/`TarifModule` (singular). Follow the existing name of whatever module you edit.
- **Typos are load-bearing** (stored data depends on them): `avaible`, `getAllComapnyforDropDown`, `getLigsById`, `WAITING_APPRO VAL`. Don't "fix" them without a data migration.

---

## Related files
- [architecture/03-data-models.md](../architecture/03-data-models.md)
- [`fix-back/src/app.module.ts`](../../fix-back/src/app.module.ts) — where all modules are imported

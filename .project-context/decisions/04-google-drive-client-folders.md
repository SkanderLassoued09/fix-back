# Decision: auto Google Drive client folder on company creation

**Date:** 2026-06-11 · **Scope:** `fix-back` (new `google-drive` module + company hook).
**Reuses** the existing Sheets service-account auth. Security (guards/RBAC) out of scope.

## What it does
On `createCompany`, after the company is persisted, a Google Drive folder named
**`{raisonSociale} {DD/MM/YYYY HH:mm:ss}`** (timezone `Africa/Tunis`) is auto-created and its
id/url stored on the company (`driveFolderId`, `driveFolderUrl`).
→ e.g. `Skander LASSOUED 11/06/2026 15:16:20`.

## ⚠️ Critical decision — Shared Drive (because the auth is a service account)
The Sheets integration authenticates as a **service account** (`GOOGLE_SERVICE_ACCOUNT_EMAIL`
+ `GOOGLE_PRIVATE_KEY`). A service account has **no personal Drive quota**, so creating files
in "My Drive" fails with `storageQuotaExceeded` and the folder is invisible to humans.

**Chosen:** create folders inside a **Shared Drive** the SA is a member of (Content manager),
under a parent "Clients" folder, with **`supportsAllDrives: true`** on the API call.

## External prerequisites (must be done in Google Cloud / Drive — NOT in code)
1. **Enable the Drive API** in the SAME GCP project as Sheets (`fixtronix-497415`).
2. Create a **Shared Drive** (e.g. "Clients FIXTRONIX") + a parent "Clients" folder in it.
3. **Add the service account** (`fixtronix-sheet-sync@…`) as a **Content manager** of that drive.
4. Set env (`fix-back/.env`):
   - `GOOGLE_DRIVE_PARENT_FOLDER_ID` — the parent "Clients" folder id (**required to enable**).
   - `GOOGLE_DRIVE_ID` — Shared Drive id (informational).
   - `DRIVE_FOLDER_DATE_FORMAT` — default `DD/MM/YYYY HH:mm:ss`; use `YYYY-MM-DD_HH-mm-ss` if
     Drive **desktop sync** is used (`/` and `:` are illegal filename chars on Windows/macOS,
     although the Drive **API** accepts them).
   - `APP_TIMEZONE` — `Africa/Tunis`.

Until `GOOGLE_DRIVE_PARENT_FOLDER_ID` is set, the feature is **inert** (see best-effort below).

## Behaviour
- **Best-effort (§8):** Drive failure NEVER blocks company creation. On error it logs and leaves
  `driveFolderId = null` (repairable). Verified: with Drive unconfigured, `createCompany`
  returns the company with `driveFolderId: null`, no error.
- **Idempotent (§7):** the folder name is unique per second, so we do NOT dedupe by name (would
  never match → duplicates). Idempotence is by **`driveFolderId`**: if set, never recreate.
- **Repair path:** mutation **`ensureClientFolder(companyId)`** — (re)creates the folder only
  when `driveFolderId` is null. The single (re)creation entry point outside `createCompany`.

## Files
- `src/google-drive/google-drive.service.ts` — auth (SA + `drive` scope), `buildFolderName`
  (tz + configurable format, sanitizes only the name part), `createClientFolder`
  (`supportsAllDrives: true`).
- `src/google-drive/google-drive.module.ts` — provides/exports the service.
- `company.module.ts` imports it; `company.service.ts` calls it best-effort in `createcompany`
  + `ensureClientFolder`; `company.resolver.ts` exposes the repair mutation.
- `company.entity.ts` — `driveFolderId` / `driveFolderUrl` (`@Prop` + nullable `@Field`).
  (Mongoose — no Prisma in this project; "migration" = additive schema fields, back-compatible.)

## Deferred (optional §9 — confirm before building)
- **Rename** on `raisonSociale` change → keep the **original creation date** in the name.
- **Delete** company → trash the folder, or keep documents (recommended: keep).
- Standard **sub-folders** (`Devis`, `Interventions`, `Contrats`) at creation.

## Verification
- Name builder matches the spec exactly (`Skander LASSOUED 11/06/2026 15:16:20`, Tunis UTC+1);
  safe format → `Skander LASSOUED 2026-06-11_15-16-20`.
- Company e2e **25/25** (create still green with Drive unconfigured).
- Live folder creation (folder appears in the Shared Drive, link opens) can only be verified
  once the external prerequisites above are completed.

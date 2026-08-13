/**
 * Migration 006 — Renommage du statut de clôture : ATTENTE_BL_FACTURE → CLOSING.
 *
 * La phase d'attente des documents de clôture (Bon de Livraison + Facture avant
 * FINISHED) porte désormais la VALEUR de statut `CLOSING` (et le libellé
 * « CLOSING ») au lieu de `ATTENTE_BL_FACTURE`. La CLÉ TS `AttenteBlFacture` est
 * conservée côté code — seule la valeur stockée change.
 *
 * Renomme les valeurs stockées dans les collections qui portent un `status`
 * synchronisé avec `Di.status` : `dis`, `stats`, `logsdis`.
 *
 * Le code TOLÈRE l'ancienne valeur (`CLOSING_STATUS_VALUES` / `isClosingStatus`
 * côté back, maps dual-clés côté front), donc cette migration peut tourner
 * AVANT ou APRÈS le déploiement sans casser les DI en vol.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture.
 * Idempotent. Run (rapport) :
 *   mongosh "mongodb://localhost:27017/<DB>" migrations/006-rename-attente-bl-facture-to-closing.js
 */
const DRY_RUN = true;

print('== Migration 006: ATTENTE_BL_FACTURE → CLOSING ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const OLD = 'ATTENTE_BL_FACTURE';
const NEW = 'CLOSING';

for (const name of ['dis', 'stats', 'logsdis']) {
  const col = db.getCollection(name);
  const n = col.countDocuments({ status: OLD });
  print(`  ${name}: ${OLD} → ${NEW} : ${n}`);
  if (!DRY_RUN && n > 0)
    col.updateMany({ status: OLD }, { $set: { status: NEW } });
}

print(DRY_RUN ? '-- FIN (dry run). --' : '-- FIN (appliqué). --');

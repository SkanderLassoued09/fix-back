/**
 * Migration 013 — Champs de date des DI stockés en CHAÎNE.
 *
 *   1. RECENSE les DI dont `createdAt` / `updatedAt` / `statusUpdatedAt` /
 *      `retourDate` / `dateReception` n'est pas de type `date`.
 *   2. CONVERTIT les valeurs ANALYSABLES en vraie `Date`.
 *   3. LISTE bruyamment les valeurs illisibles — elles ne sont ni supprimées ni
 *      devinées : c'est une décision humaine.
 *
 * POURQUOI. Le schéma déclare ces champs en Date (via `timestamps: true`), mais
 * un document hérité ou édité à la main peut y porter une chaîne. UNE SEULE
 * suffisait à faire tomber toute l'agrégation du leaderboard technicien :
 * `$subtract` sur une chaîne interrompt le pipeline entier (« can't $subtract
 * date from string », remonté en 500 au client). Le pipeline est désormais
 * blindé (`$convert … onError: null`), mais une DI illisible sort quand même du
 * calcul du TAT — d'où cette réparation des données.
 *
 * `null` est un état LÉGITIME (une DI sans retour porte `retourDate: null`) et
 * n'est jamais touché ; un champ absent non plus.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture.
 * Idempotente. Run (rapport) :
 *   mongosh "mongodb://localhost:27017/<DB>" migrations/013-di-date-types.js
 * NB : chaque poste a SA base (localhost en dur) — lancer sur chacune.
 */
const DRY_RUN = true;

const DATE_FIELDS = [
  'createdAt',
  'updatedAt',
  'statusUpdatedAt',
  'retourDate',
  'dateReception',
];

print('== Migration 013: champs de date des DI en chaîne ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');
print('  total DI : ' + db.dis.countDocuments({}));

let converted = 0;
let unreadable = 0;

DATE_FIELDS.forEach((field) => {
  const bad = db.dis
    .find(
      { [field]: { $exists: true, $ne: null, $not: { $type: 'date' } } },
      { _idnum: 1, status: 1, [field]: 1 },
    )
    .toArray();

  if (bad.length === 0) {
    print('  ✅ ' + field + ' : aucun');
    return;
  }

  print('  ❌ ' + field + ' : ' + bad.length + ' document(s)');
  bad.forEach((d) => {
    const raw = d[field];
    const parsed = typeof raw === 'string' ? new Date(raw) : null;
    const ok = parsed && !isNaN(parsed.getTime());

    if (ok) {
      converted++;
      print(
        '     → ' + d._id + ' (' + (d._idnum || '-') + ') ' +
          JSON.stringify(raw) + '  ⇒  ' + parsed.toISOString(),
      );
      if (!DRY_RUN) {
        db.dis.updateOne({ _id: d._id }, { $set: { [field]: parsed } });
      }
    } else {
      unreadable++;
      print(
        '     ⛔ ' + d._id + ' (' + (d._idnum || '-') + ') ' +
          JSON.stringify(raw) + '  ILLISIBLE — laissé en l’état, à trancher',
      );
    }
  });
});

print('');
print('  bilan : ' + converted + ' converti(s) · ' + unreadable + ' illisible(s)');
if (unreadable > 0) {
  print('  ⚠ les valeurs illisibles sortent du calcul du TAT tant qu’elles ne sont pas corrigées.');
}
print(
  DRY_RUN
    ? '-- FIN (dry run). Relancer avec DRY_RUN = false pour appliquer. --'
    : '-- FIN (apply). --',
);

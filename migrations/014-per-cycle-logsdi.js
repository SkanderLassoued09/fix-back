/**
 * Migration 014 — Un DOSSIER PAR CYCLE, cycle 0 compris.
 *
 * POURQUOI. Le flux original et les flux retour partageaient les mêmes champs
 * sur la DI (verdict, composants, documents, prix). Un cycle retour écrasait
 * donc les données du cycle 0, et l'onglet « Retour N » du dossier retombait
 * sur la DI dès que sa ligne de cycle était incomplète : on y voyait la liste
 * PDR et les fichiers du flux original. `logsdis` devient LE dossier par cycle
 * (cycle 0 inclus) ; la DI n'en garde qu'un miroir du cycle courant.
 *
 * CE QUE FAIT CETTE MIGRATION
 *   A. RECENSE (toujours, même en DRY RUN).
 *   B. RÉPARE `ignoreCount`, VERS LE HAUT UNIQUEMENT, sous règle des DEUX
 *      TÉMOINS : W1 = max(logsdis.idIgnore), W2 = nb d'entrées RETOUR* dans
 *      `statusHistory`. On ne corrige que si les deux témoins concordent.
 *   C. CRÉE la ligne de cycle 0 manquante.
 *   D. COMPLÈTE `driveDocs` sur les lignes de cycle qui n'ont qu'une URL nue.
 *   E. POSE `closedAt` sur les cycles clos.
 *
 * CE QU'ELLE NE FAIT JAMAIS
 *   - supprimer une ligne `logsdis` ;
 *   - ABAISSER un `ignoreCount` (un cycle peut avoir été ouvert sans qu'aucun
 *     technicien n'y soit affecté : il n'a alors pas de ligne, et l'absence de
 *     ligne n'est donc PAS une preuve d'absence de cycle) ;
 *   - INVENTER un verdict ou un fichier. Quand la donnée d'origine a déjà été
 *     écrasée, la ligne est marquée `reconstructed: true` et le champ reste
 *     VIDE — l'UI affiche « non renseigné pour ce cycle », jamais une valeur
 *     fausse. Même convention que la migration 013 : signaler, pas deviner.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture.
 * Idempotente. Run (rapport) :
 *   mongosh "$MONGODB_URI" migrations/014-per-cycle-logsdi.js
 * L'URI vient de `.env.${NODE_ENV}` (cf. app.module.ts, fail-fast sans
 * fallback) — à lancer sur CHAQUE environnement (dev / preprod / prod).
 */
const DRY_RUN = true;

print('== Migration 014: un dossier par cycle (cycle 0 compris) ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const RETOUR_STATUSES = ['RETOUR1', 'RETOUR2', 'RETOUR3'];
const DOC_TYPES = [
  { type: 'Devis', scalar: 'devis' },
  { type: 'BC', scalar: 'bon_de_commande' },
  { type: 'BL', scalar: 'bon_de_livraison' },
  { type: 'Facture', scalar: 'facture' },
];
// Même extraction que `di-image.controller.ts` : sans `driveFileId`, une
// référence est invisible pour `isDriveDocRef`, donc pour les portes docs.
const DRIVE_ID_RE = /\/(?:file\/)?d\/([A-Za-z0-9_-]{10,})/;

const isEmpty = (v) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0);

const humanDecisions = [];

// `_id` des lignes logsdis = UUID v4 en CHAÎNE (cf. `logs-di.service.ts`, qui
// utilise `uuidv4()`). `UUID()` de mongosh renvoie un BSON Binary : il
// produirait un type d'_id différent du reste de la collection.
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── A. Recensement ──────────────────────────────────────────────────────────
const dis = db.dis.find({ isDeleted: { $ne: true } }).toArray();
print('  DI non supprimées : ' + dis.length);
print('  lignes logsdis    : ' + db.logsdis.countDocuments({}));

const state = dis.map((d) => {
  const rows = db.logsdis.find({ _idDi: d._id }).toArray();
  const w1 = rows.length ? Math.max.apply(null, rows.map((r) => r.idIgnore || 0)) : 0;
  const hist = (d.statusHistory || []).filter(
    (h) => RETOUR_STATUSES.indexOf(h.status) !== -1,
  );
  return {
    di: d,
    rows: rows,
    ic: d.ignoreCount || 0,
    w1: w1,
    w2: hist.length,
    w2Reconstructed: hist.filter((h) => h.reconstructed).length,
  };
});

const mismatched = state.filter((s) => s.ic !== s.w1 || (s.w2 > 0 && s.w2 !== s.ic));
print('  compteurs discordants : ' + mismatched.length);
mismatched.forEach((s) =>
  print(
    '     ' + s.di._idnum + ' ignoreCount=' + s.ic +
    ' maxLigne=' + s.w1 + ' histRETOUR=' + s.w2 +
    (s.w2Reconstructed ? ' (dont ' + s.w2Reconstructed + ' reconstruites)' : ''),
  ),
);

// ── B. Réparation du compteur — VERS LE HAUT, deux témoins ──────────────────
print('');
print('-- B. compteurs de cycle --');
let counterFixed = 0;
state.forEach((s) => {
  const target = Math.max(s.w1, s.w2);

  if (s.ic > target) {
    // Jamais d'abaissement : un cycle sans technicien affecté n'a pas de ligne.
    humanDecisions.push(
      s.di._idnum + ' : ignoreCount=' + s.ic + ' > témoins (ligne=' + s.w1 +
      ', historique=' + s.w2 + '). Cycle ouvert sans affectation, ou clic ' +
      'erroné ? NON MODIFIÉ — décision humaine.',
    );
    return;
  }
  if (s.ic === target) return;

  // ic < target : on ne remonte que si les deux témoins concordent, ou si
  // l'historique s'abstient (DI antérieures au suivi des retours).
  const witnessesAgree = s.w2 > 0 ? s.w1 === s.w2 : true;
  if (!witnessesAgree) {
    humanDecisions.push(
      s.di._idnum + ' : témoins en désaccord (ligne=' + s.w1 +
      ', historique=' + s.w2 + '). NON MODIFIÉ.',
    );
    return;
  }

  print('     ' + s.di._idnum + ' : ignoreCount ' + s.ic + ' → ' + target);
  if (!DRY_RUN) {
    db.dis.updateOne({ _id: s.di._id }, { $set: { ignoreCount: target } });
  }
  s.ic = target;
  counterFixed++;
});
print('  compteurs corrigés : ' + counterFixed);

// ── C. Ligne de cycle 0 ─────────────────────────────────────────────────────
print('');
print('-- C. lignes de cycle 0 --');
let created = 0;
let createdExact = 0;
let createdPartial = 0;

state.forEach((s) => {
  const d = s.di;
  if (s.rows.some((r) => (r.idIgnore || 0) === 0)) return; // déjà présente

  const base = {
    _id: uuidv4(),
    _idDi: d._id,
    idIgnore: 0,
    isDeleted: false,
  };

  if (s.ic === 0) {
    // La DI EST le cycle 0 : recopie EXACTE, aucune supposition.
    Object.assign(base, {
      can_be_repaired: d.can_be_repaired,
      contain_pdr: d.contain_pdr,
      array_composants: d.array_composants || [],
      remarque_tech_diagnostic: d.remarque_tech_diagnostic,
      remarque_tech_repair: d.remarque_tech_repair,
      remarque_magasin: d.remarque_magasin,
      remarque_coordinator: d.remarque_coordinator,
      isErrorFromFixtronix: d.isErrorFromFixtronix,
      di_category_id: d.di_category_id,
      devis: d.devis,
      bon_de_commande: d.bon_de_commande,
      bon_de_livraison: d.bon_de_livraison,
      facture: d.facture,
      driveDocs: d.driveDocs || {},
      price: d.price,
      final_price: d.final_price,
      repairEstimate: d.repairEstimate,
      reconstructed: false,
    });
    createdExact++;
  } else {
    // La DI a DÉJÀ été écrasée par un cycle retour. On ne recopie QUE ce qui
    // est distinguable du cycle courant ; sinon on laisse VIDE et on signale.
    const current = s.rows.filter((r) => (r.idIgnore || 0) === s.ic)[0] || {};
    const ambiguous = [];

    ['can_be_repaired', 'contain_pdr', 'array_composants',
     'remarque_tech_diagnostic'].forEach((f) => {
      const diVal = JSON.stringify(d[f] === undefined ? null : d[f]);
      const curVal = JSON.stringify(current[f] === undefined ? null : current[f]);
      if (isEmpty(d[f])) return;
      if (diVal === curVal) {
        // Impossible de trancher : est-ce la donnée du cycle 0 restée en
        // place, ou le verdict du retour écrit sur la DI ? On n'écrit rien.
        ambiguous.push(f);
        return;
      }
      base[f] = d[f];
    });

    // Les documents du cycle 0 n'ont jamais été déplacés : un retour écrivait
    // dans `logsdis`, pas dans `driveDocs`. La DI porte donc bien ceux du
    // cycle 0.
    Object.assign(base, {
      devis: d.devis,
      bon_de_commande: d.bon_de_commande,
      bon_de_livraison: d.bon_de_livraison,
      facture: d.facture,
      driveDocs: d.driveDocs || {},
    });

    base.reconstructed = true;
    base.reconstructedReason =
      'Cycle 0 reconstitué : la DI avait déjà été écrasée par un cycle retour' +
      (ambiguous.length
        ? ' — champs indéterminables laissés vides : ' + ambiguous.join(', ')
        : '');

    if (ambiguous.length) {
      humanDecisions.push(
        d._idnum + ' : cycle 0 — champs indéterminables (' +
        ambiguous.join(', ') + '). Laissés VIDES, affichés « non renseigné ».',
      );
    }
    createdPartial++;
  }

  print(
    '     ' + d._idnum + ' : cycle 0 ' +
    (base.reconstructed ? 'RECONSTITUÉ' : 'exact'),
  );
  if (!DRY_RUN) {
    db.logsdis.updateOne(
      { _idDi: d._id, idIgnore: 0 },
      { $setOnInsert: base },
      { upsert: true },
    );
  }
  created++;
});
print('  lignes cycle 0 créées : ' + created +
      ' (exactes ' + createdExact + ', reconstituées ' + createdPartial + ')');

// ── D. driveDocs sur les lignes de cycle ────────────────────────────────────
print('');
print('-- D. références Drive structurées --');
let docFixed = 0;
let docUnparsable = 0;

db.logsdis.find({}).forEach(function (row) {
  const patch = {};
  DOC_TYPES.forEach(function (t) {
    const url = row[t.scalar];
    if (isEmpty(url)) return;
    if (row.driveDocs && row.driveDocs[t.type] && row.driveDocs[t.type].driveFileId) {
      return; // déjà structurée
    }
    const m = DRIVE_ID_RE.exec(String(url));
    if (!m) {
      docUnparsable++;
      humanDecisions.push(
        'Ligne ' + row._idDi + ' cycle ' + row.idIgnore + ' : lien ' + t.type +
        ' non analysable (' + url + '). Laissé tel quel.',
      );
      return;
    }
    // `name: null` est honnête : le nom réel n'a jamais été stocké pour ces
    // lignes. L'UI retombe sur le libellé générique.
    patch['driveDocs.' + t.type] = {
      driveFileId: m[1],
      webViewLink: String(url),
      name: null,
    };
  });
  if (Object.keys(patch).length === 0) return;
  print('     ' + row._idDi + ' cycle ' + row.idIgnore + ' : ' +
        Object.keys(patch).length + ' réf(s)');
  if (!DRY_RUN) db.logsdis.updateOne({ _id: row._id }, { $set: patch });
  docFixed++;
});
print('  lignes complétées : ' + docFixed + ' · liens non analysables : ' + docUnparsable);

// ── E. closedAt sur les cycles clos ─────────────────────────────────────────
print('');
print('-- E. clôture des cycles --');
let closed = 0;
state.forEach((s) => {
  const rows = db.logsdis.find({ _idDi: s.di._id }).sort({ idIgnore: 1 }).toArray();
  rows.forEach(function (row, idx) {
    const cycle = row.idIgnore || 0;
    if (cycle >= s.ic) return;      // cycle courant : pas clos
    if (row.closedAt) return;       // idempotence

    // Date de clôture = entrée RETOUR{cycle+1} de l'historique, sinon
    // ouverture du cycle suivant, sinon rien (signalé).
    const mark = (s.di.statusHistory || []).filter(
      (h) => h.status === 'RETOUR' + (cycle + 1),
    )[0];
    const next = rows[idx + 1];
    const at = (mark && mark.at) || (next && next.createdAt) || null;

    if (!at) {
      humanDecisions.push(
        s.di._idnum + ' cycle ' + cycle +
        ' : aucune date de clôture déductible. closedAt laissé null.',
      );
      return;
    }
    if (!DRY_RUN) {
      db.logsdis.updateOne({ _id: row._id }, { $set: { closedAt: at } });
    }
    closed++;
  });
});
print('  cycles clôturés : ' + closed);

// ── F. index unique {_idDi, ignoreCount} sur stats ──────────────────────────
// Pendant exact de l'index de `logsdis`. La collection n'avait AUCUN index hors
// `_id`, alors que le schéma déclarait `_idDi` unique (neutralisé par
// `autoIndex: false`) — un `syncIndexes()` aurait cassé les retours.
print('');
print('-- F. index stats {_idDi, ignoreCount} --');
const statDupes = db
  .getCollection('stats')
  .aggregate([
    { $group: { _id: { d: '$_idDi', c: '$ignoreCount' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ])
  .toArray();

if (statDupes.length) {
  // On N'ARBITRE PAS : deux lignes de stats pour le même cycle portent des
  // temps de travail. Les fusionner ou en supprimer une fausserait la
  // facturation.
  print('  ⚠ ' + statDupes.length + ' doublon(s) — index NON créé.');
  statDupes.forEach((g) =>
    humanDecisions.push(
      'stats : DI ' + g._id.d + ' cycle ' + g._id.c + ' ×' + g.n +
      '. Fusion impossible sans arbitrage (temps facturable). Index non créé.',
    ),
  );
} else if (DRY_RUN) {
  print('  aucun doublon → index créable.');
} else {
  db.getCollection('stats').createIndex(
    { _idDi: 1, ignoreCount: 1 },
    { unique: true },
  );
  print('  ✅ index créé.');
}

// ── Décisions humaines ──────────────────────────────────────────────────────
print('');
print('== DÉCISIONS HUMAINES (' + humanDecisions.length + ') ==');
if (humanDecisions.length === 0) {
  print('  ✅ aucune.');
} else {
  humanDecisions.forEach((m, i) => print('  ' + (i + 1) + '. ' + m));
}
print('');
print(DRY_RUN
  ? '-- DRY RUN terminé : AUCUNE écriture. Relire ci-dessus, puis DRY_RUN=false. --'
  : '-- APPLY terminé. Relancer le script : il doit rapporter 0 changement. --');

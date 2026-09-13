/**
 * Fabrique de documents de seed pour les DI — version FORME RÉELLE.
 *
 * Pourquoi un `.mjs` à côté de `di-seed.ts` : les scripts de seed tournent sous
 * `node` nu (pas de ts-node), ils ne peuvent donc pas importer le `.ts` — lui
 * reste réservé aux specs Playwright qui, elles, passent par le transpileur.
 *
 * RÈGLE CENTRALE — une DI seedée, c'est TROIS documents, jamais un :
 *   `dis`     le miroir du cycle courant ;
 *   `stats`   index unique {_idDi, ignoreCount} ; `Stat.status` doit MIROIR
 *             `Di.status` — c'est `stats` (et non `dis`) que la liste
 *             technicien interroge (src/stat/stat.service.ts:774) ;
 *   `logsdis` index unique {_idDi, idIgnore} — LE dossier du cycle
 *             (src/logs-di/entities/logs-di.entity.ts:106).
 * Ne poser que `dis` produit une file technicien vide ; ne poser que `stats`
 * produit une ligne dont le modal est blanc.
 */

/** Les collections qu'un seed touche — même liste pour l'écriture et la purge. */
export const SEEDED_COLLECTIONS = [
  'dis',
  'stats',
  'logsdis',
  'notifications',
  'system_events',
];

/**
 * Résout À L'EXÉCUTION les entités que la DI référence. Rien n'est codé en dur :
 * deux bases coexistent sur ce poste avec des `_id` différents pour le même
 * compte, et un id figé rend la DI invisible dans la liste du rôle visé.
 */
export async function resolveRefs(db) {
  // Les comptes sont résolus par RÔLE, pas par username : `qa/utils/roles.ts`
  // annonce `coordinateur` et `magasin`, qui n'existent pas — la coordinatrice
  // est `Rachida` et le magasin `houda`. Le rôle, lui, ne bouge pas.
  // (`COORDIANTOR` est la faute de frappe réellement stockée en base.)
  const byRole = async (role) =>
    db
      .collection('profiles')
      .findOne({ role, isDeleted: { $ne: true } }, { projection: { _id: 1, username: 1 } });

  const [tech, coordinator, magasin, adminManager] = await Promise.all([
    byRole('TECH'),
    byRole('COORDIANTOR'),
    byRole('MAGASIN'),
    byRole('ADMIN_MANAGER'),
  ]);
  if (!tech) throw new Error(`Aucun profil TECH dans ${db.databaseName} — seed impossible.`);

  const [client, company, location, category, composants] = await Promise.all([
    db.collection('clients').findOne({ isDeleted: { $ne: true } }),
    db.collection('companies').findOne({ isDeleted: { $ne: true } }),
    db.collection('locations').findOne({ isDeleted: { $ne: true }, avaible: true }),
    db.collection('dicategories').findOne({ isDeleted: { $ne: true } }),
    // Jointure DI → catalogue PAR NOM : prendre des composants RÉELS et en stock
    // pour que le décrément et le calcul de prix aient un sens.
    db
      .collection('composants')
      .find({ isDeleted: { $ne: true }, quantity_stocked: { $gt: 2 } })
      .limit(3)
      .toArray(),
  ]);

  return {
    techId: String(tech._id),
    techName: tech.username,
    coordinatorId: coordinator ? String(coordinator._id) : null,
    coordinatorName: coordinator?.username ?? null,
    magasinId: magasin ? String(magasin._id) : null,
    magasinName: magasin?.username ?? null,
    adminId: adminManager ? String(adminManager._id) : null,
    adminName: adminManager?.username ?? null,
    clientId: client?._id ?? null,
    companyId: company?._id ?? null,
    locationId: location?._id ?? null,
    // ATTENTION — `Stat.location_id` porte en pratique le NOM de l'emplacement
    // (« A57 »), pas l'uuid : la liste technicien affiche ce champ BRUT (aucun
    // populate dans getDiForTech). Y mettre l'uuid ferait afficher l'uuid.
    locationName: location?.location_name ?? null,
    categoryId: category?._id ?? null,
    categoryLabel: category?.category ?? null,
    composants: composants.map((c) => ({ nameComposant: c.name, quantity: 1 })),
  };
}

/**
 * Parent canonique de chaque statut — sert à reconstruire un `statusHistory`
 * plausible. Le driver `mongodb` brut contourne les hooks Mongoose
 * (di.entity.ts:278-329) qui posent normalement `statusUpdatedAt` +
 * `statusHistory` : sans cette reconstruction, la timeline de la DI est vide.
 */
const PARENT = {
  CREATED: null,
  PENDING1: 'CREATED',
  DIAGNOSTIC: 'PENDING1',
  INDIAGNOSTIC: 'DIAGNOSTIC',
  DIAGNOSTIC_Pause: 'INDIAGNOSTIC',
  MagasinEstimation: 'INDIAGNOSTIC',
  CONFIRMATION: 'MagasinEstimation',
  ATTENTE_CONFIRMATION_COORDINATION: 'CONFIRMATION',
  MAGASIN_FINALISATION: 'ATTENTE_CONFIRMATION_COORDINATION',
  PENDING2: 'INDIAGNOSTIC',
  PRICING_DIAG: 'PENDING2',
  PRICING: 'PENDING2',
  WAITING_DEVIS: 'PRICING_DIAG',
  WAITING_BC: 'WAITING_DEVIS',
  NEGOTIATION2: 'WAITING_BC',
  PENDING3: 'WAITING_BC',
  REPARATION: 'PENDING3',
  REPARATION_Pause: 'INREPARATION',
  INREPARATION: 'REPARATION',
  WAITING_BL: 'INREPARATION',
  WAITING_FACTURE: 'WAITING_BL',
  FINISHED: 'WAITING_FACTURE',
  IRREPARABLE: 'INDIAGNOSTIC',
  ANNULER: 'PENDING2',
  RETOUR1: 'FINISHED',
  RETOUR2: 'FINISHED',
  RETOUR3: 'FINISHED',
};

/** Chaîne CREATED → … → `status`, en remontant les parents. */
function lineage(status, overrides = {}) {
  const parents = { ...PARENT, ...overrides };
  const chain = [];
  let cur = status;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    cur = parents[cur];
  }
  return chain;
}

/**
 * `statusHistory` reconstruit. Pour un retour (cycle > 0) on préfixe le cycle 0
 * complet jusqu'à FINISHED puis le RETOURn, sinon la timeline prétendrait qu'un
 * retour est né en diagnostic.
 */
function buildHistory(status, cycle, now, parentOverrides) {
  const steps = [];
  for (let c = 0; c < cycle; c += 1) {
    // Seul le cycle 0 part de CREATED. Les cycles suivants reprennent APRÈS le
    // `DIAGNOSTIC` réémis par le retour précédent — sinon la timeline prétend que
    // la DI a été recréée à chaque retour.
    const full = lineage('FINISHED');
    steps.push(...(c === 0 ? full : full.slice(3)), `RETOUR${c + 1}`, 'DIAGNOSTIC');
  }
  steps.push(...(cycle > 0 ? lineage(status, parentOverrides).slice(3) : lineage(status, parentOverrides)));

  // Un pas toutes les 45 min, en remontant depuis maintenant : l'ordre
  // chronologique est ce que lit la timeline du front.
  const STEP_MS = 45 * 60 * 1000;
  const start = now.getTime() - steps.length * STEP_MS;
  return steps.map((s, i) => ({ status: s, at: new Date(start + i * STEP_MS) }));
}

/** Un document Drive factice, à la forme attendue par `maybeAdvanceDocGate`. */
const doc = (kind, id) => ({
  driveFileId: `qa-${kind}-${id}`,
  webViewLink: `https://example.invalid/${kind}/${id}`,
  name: `${kind}-${id}.pdf`,
});

/**
 * Documents déjà présents à ce stade du flux. Les portes documentaires avancent
 * à l'UPLOAD (`maybeAdvanceDocGate`, di.service.ts:2534) : une DI garée APRÈS une
 * porte doit donc porter le document qui l'a fait avancer, sinon son état est
 * incohérent et la porte suivante ne peut pas être testée.
 */
function docsFor(status, id) {
  const devis = { Devis: doc('devis', id) };
  const bc = { BC: doc('bc', id) };
  const bl = { BL: doc('bl', id) };
  const facture = { Facture: doc('facture', id) };
  switch (status) {
    case 'WAITING_BC':
      return { ...devis };
    case 'NEGOTIATION2':
    case 'PENDING3':
    case 'REPARATION':
    case 'REPARATION_Pause':
    case 'INREPARATION':
    case 'WAITING_BL':
      return { ...devis, ...bc };
    case 'WAITING_FACTURE':
      return { ...devis, ...bc, ...bl };
    case 'FINISHED':
      return { ...devis, ...bc, ...bl, ...facture };
    default:
      return {};
  }
}

/**
 * URLs scalaires des documents d'un cycle, telles que `writeCurrentCycleDoc` les
 * écrit sur la ligne `logsdis` (le back y pose l'URL en scalaire ET la référence
 * structurée dans `driveDocs` du miroir). Sans elles, la modale « Affectation des
 * Fichiers » n'a rien à montrer ni en « Fichiers principaux » ni dans la frise.
 */
function docScalarsFor(status, id) {
  const docs = docsFor(status, id);
  const map = {
    Devis: 'devis',
    BC: 'bon_de_commande',
    BL: 'bon_de_livraison',
    Facture: 'facture',
  };
  const out = {};
  for (const [kind, field] of Object.entries(map)) {
    if (docs[kind]) out[field] = docs[kind].webViewLink;
  }
  return out;
}

/** Drapeaux de la poignée de main magasin ↔ coordination, par statut. */
function handshakeFor(status) {
  switch (status) {
    case 'ATTENTE_CONFIRMATION_COORDINATION':
      return {
        isSentToCoordinator: true,
        isConfirmedComponentFromCoordinator: false,
        handleSendingNotificationBetweenCoordinatorAndMagasin: 'IN_MAGASIN',
      };
    case 'MAGASIN_FINALISATION':
      return {
        isSentToCoordinator: true,
        isConfirmedComponentFromCoordinator: true,
        handleSendingNotificationBetweenCoordinatorAndMagasin: 'IN_COORDINATOR',
      };
    default:
      return {
        isSentToCoordinator: false,
        isConfirmedComponentFromCoordinator: false,
        handleSendingNotificationBetweenCoordinatorAndMagasin: 'IN_COORDINATOR',
      };
  }
}

/** Temps de diagnostic/réparation plausibles selon l'avancement. */
const REPAIR_STATUSES = new Set([
  'PENDING3', 'REPARATION', 'REPARATION_Pause', 'INREPARATION',
  'WAITING_BL', 'WAITING_FACTURE', 'FINISHED',
]);

/**
 * Construit le triplet {di, stat, logs} d'un scénario.
 *
 * @param spec.id        `_id` de la DI (préfixé, cf. PREFIX du script appelant)
 * @param spec.idnum     référence humaine affichée (hors format compteur `T{n}`)
 * @param spec.status    statut visé
 * @param spec.cycle     `ignoreCount` : 0 = flux original, ≥ 1 = retour
 * @param spec.rep       `can_be_repaired`
 * @param spec.pdr       `contain_pdr`
 * @param spec.fixtronix `isErrorFromFixtronix` — `null` = verdict NON tranché
 * @param spec.payant    `diagnosticPayant`
 * @param spec.comps     composants du cycle (défaut : ceux des refs si `pdr`)
 */
export function buildDiTriple(spec, refs, now = new Date()) {
  const {
    id, idnum, title, next, status, cycle = 0,
    rep = true, pdr = false, fixtronix = false, payant = true,
    comps, role = 'Tech', parentOverrides, extra = {},
  } = spec;

  // Non réparable ⇒ aucune pièce (règle métier) ; PDR ⇒ au moins une pièce, car
  // `contain_pdr: true` avec `array_composants: []` est REFUSÉ par le serveur
  // (« PDR déclaré sans composant », di.diagnostic-routing.spec.ts).
  const composants = comps !== undefined ? comps : pdr && rep ? refs.composants.slice(0, 1) : [];
  const history = buildHistory(status, cycle, now, parentOverrides);
  const statusUpdatedAt = history[history.length - 1]?.at ?? now;
  const createdAt = history[0]?.at ?? now;

  const verdict = {
    can_be_repaired: rep,
    contain_pdr: pdr,
    array_composants: composants,
    di_category_id: refs.categoryId,
    remarque_tech_diagnostic: `Diagnostic de démonstration — ${title}`,
    // Le verdict Fixtronix n'a de sens qu'en retour, et `null` signifie
    // « le technicien n'a pas encore tranché » (l'état réel avant saisie).
    ...(cycle > 0 && fixtronix !== null ? { isErrorFromFixtronix: fixtronix } : {}),
  };

  const di = {
    _id: id,
    _idnum: idnum,
    title,
    description: next,
    nSerie: `QA-${idnum}`,
    dateReception: createdAt,
    createdBy: refs.adminId ?? refs.techId,
    // Une DI porte l'un OU l'autre ; `type_client` doit suivre.
    ...(refs.companyId
      ? { company_id: refs.companyId, client_id: null, type_client: 'Company' }
      : { company_id: null, client_id: refs.clientId, type_client: 'Client' }),
    location_id: refs.locationId,
    status,
    ...verdict,
    // Alias lus par le préremplissage du modal technicien
    // (`di.isPdr ?? log.contain_pdr ?? true` — un `false` persisté est une décision).
    isPdr: pdr,
    isReparable: rep,
    diagnosticPayant: payant,
    ignoreCount: cycle,
    current_workers_ids: [refs.techId],
    current_roles: [role],
    ...handshakeFor(status),
    needsDevisBeforeRepair: !!extra.needsDevisBeforeRepair,
    gotComposantFromMagasin: false,
    confirmationComposant: null,
    // Jamais fabriqué : aucun site d'ÉCRITURE de `cycle0Snapshot` n'existe dans
    // `src/` (4 lectures, 0 écriture) — l'app ne produit jamais cette donnée.
    cycle0Snapshot: null,
    pricingRequestSentAt: null,
    pricingRequestSentBy: null,
    componentsConfirmedAt: status === 'MAGASIN_FINALISATION' ? statusUpdatedAt : null,
    componentsConfirmedBy: status === 'MAGASIN_FINALISATION' ? refs.coordinatorId : null,
    stockDecrementedAt: null,
    repairEstimate: null,
    diagnosticEstimate: null,
    price: null,
    final_price: null,
    driveDocs: docsFor(status, idnum),
    ...docScalarsFor(status, idnum),
    retourReason: cycle > 0 ? `Retour client — cycle ${cycle}` : null,
    retourDate: cycle > 0 ? createdAt : null,
    annulationParClient: null,
    annulationMotif: null,
    annulationCommentaire: null,
    annulePar: null,
    annuleLe: null,
    pvReunions: [],
    isDeleted: false,
    isOpenedOnce: false,
    statusHistory: history,
    statusUpdatedAt,
    createdAt,
    updatedAt: statusUpdatedAt,
    __v: 0,
    ...extra,
  };

  const stat = {
    _id: `stat-${id}`,
    _idDi: id,
    diRef: id,
    id_tech_diag: refs.techId,
    id_tech_rep: refs.techId,
    location_id: refs.locationName,
    // MIROIR obligatoire : c'est ce champ que la liste technicien filtre.
    status,
    diag_time: status === 'DIAGNOSTIC' || status === 'PENDING1' || status === 'CREATED' ? '' : '00:12:30',
    rep_time: REPAIR_STATUSES.has(status) ? '00:21:00' : '',
    diagRunStartedAt: null,
    repRunStartedAt: null,
    pauseLogs: [],
    diagSegments: [],
    repSegments: [],
    diagAssignments: [],
    ignoreCount: cycle,
    retour_count: cycle,
    createdAt,
    updatedAt: statusUpdatedAt,
  };

  // Une ligne par cycle. Les cycles antérieurs sont CLOS ; seul le cycle courant
  // porte le verdict vivant.
  const logs = [];
  for (let c = 0; c <= cycle; c += 1) {
    const current = c === cycle;
    logs.push({
      _id: `log-${id}-${c}`,
      _idDi: id,
      idIgnore: c,
      ...(current
        ? verdict
        : { can_be_repaired: true, contain_pdr: false, array_composants: [], isErrorFromFixtronix: false }),
      status: current ? status : 'FINISHED',
      // Les documents appartiennent au CYCLE, pas à la DI : un cycle clos a
      // atteint FINISHED, il porte donc ses quatre documents ; le cycle courant
      // porte ceux que son statut implique. C'est ce découpage que la modale
      // « Affectation des Fichiers » relit (cycle 0 = fichiers principaux).
      ...docScalarsFor(current ? status : 'FINISHED', `${idnum}-c${c}`),
      current_workers_ids: [refs.techId],
      current_roles: [role],
      isDeleted: false,
      openedAt: createdAt,
      ...(current ? {} : { closedAt: createdAt }),
      createdAt,
      updatedAt: statusUpdatedAt,
    });
  }

  return { di, stat, logs };
}

/** Purge idempotente d'un jeu de seed, par préfixe d'`_id`. Ne touche RIEN d'autre. */
export async function purgeSeed(db, prefix) {
  const rx = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const counts = {};
  counts.dis = (await db.collection('dis').deleteMany({ _id: { $regex: rx } })).deletedCount;
  counts.stats = (await db.collection('stats').deleteMany({ _idDi: { $regex: rx } })).deletedCount;
  counts.logsdis = (await db.collection('logsdis').deleteMany({ _idDi: { $regex: rx } })).deletedCount;
  counts.notifications = (await db.collection('notifications').deleteMany({ diId: { $regex: rx } })).deletedCount;
  counts.system_events = (await db.collection('system_events').deleteMany({ diId: { $regex: rx } })).deletedCount;
  return counts;
}

/** Écrit un triplet. Purge d'abord : les index uniques rejetteraient un re-seed. */
export async function writeTriple(db, { di, stat, logs }) {
  await db.collection('dis').deleteOne({ _id: di._id });
  await db.collection('stats').deleteMany({ _idDi: di._id });
  await db.collection('logsdis').deleteMany({ _idDi: di._id });
  await db.collection('dis').insertOne(di);
  await db.collection('stats').insertOne(stat);
  if (logs.length) await db.collection('logsdis').insertMany(logs);
}

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
 *
 * UN RETOUR, c'est en plus (relevé sur de vraies DI en base, ex. T1482/T1483) :
 *   - une Stat PAR cycle (celle d'un cycle clos garde FINISHED) → `extraStats` ;
 *   - la ligne du cycle clos à la date du retour, avec son argent reporté et ses
 *     4 documents nommés `{CLIENT}_{Type}_{JJ-MM-AAAA}_{HH-mm-ss}.pdf` ;
 *   - la ligne du cycle retour ouverte à la même date, porteuse du motif ;
 *   - un événement `DI_RETOUR_n` (motif du bandeau « Retour n ») → `events`.
 * `writeTriple` n'écrit PAS `extraStats` / `events` : c'est à l'appelant de les
 * insérer (les scripts vitrine posent déjà les leurs).
 */

/** Les collections qu'un seed touche — même liste pour l'écriture et la purge. */
export const SEEDED_COLLECTIONS = [
  'dis',
  'stats',
  'logsdis',
  'notifications',
  'system_events',
];

/** Nom d'entité tel qu'il apparaît dans un nom de document Drive : lettres et chiffres, en capitales. */
function cleanEntity(raw) {
  return (
    String(raw ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase() || 'CLIENT'
  );
}

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
    // Entité des noms de documents : la DI porte la société si elle existe.
    docEntity: cleanEntity(
      company?.name ?? [client?.first_name, client?.last_name].filter(Boolean).join(''),
    ),
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
  // La préparation des composants suit le BC (dépôt du BC avec pièces → CONFIRMATION).
  CONFIRMATION: 'WAITING_BC',
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

/** Chemin d'une DI réparable AVEC pièces : magasin avant la tarification, poignée de main avant PENDING3. */
const PDR_PATH = { PENDING2: 'MagasinEstimation', PENDING3: 'MAGASIN_FINALISATION' };

const RETOUR_STATUS = /^RETOUR([123])$/;
const STEP_MS = 45 * 60 * 1000;
/** Délai client entre la fin d'un cycle et le retour suivant. */
const RETOUR_GAP_MS = 2 * 24 * 60 * 60 * 1000;
/** Un document est déposé pendant l'étape qui l'attend. */
const DOC_OFFSET_MS = 30 * 60 * 1000;

/** Motif de chaque retour (bandeau « Retour n », ligne du cycle, journal). */
export const RETOUR_REASONS = [
  'Même panne revenue après 3 jours d\'utilisation chez le client',
  'Coupure en charge toujours présente après la 1re reprise',
  'Défaut intermittent signalé une troisième fois',
];

/** Montants de démonstration d'un cycle tarifé (DT). */
const MONEY = { diag: 180, repair: 450 };

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
 * `statusHistory` reconstruit, comme en base : le cycle 0 part de CREATED ; chaque
 * retour ferme le cycle précédent (… FINISHED → RETOURn) puis repart de PENDING1
 * (la coordinatrice réaffecte). Une DI garée en RETOURn s'arrête sur ce statut.
 */
function buildHistory(status, cycle, now, parentOverrides) {
  const parked = RETOUR_STATUS.exec(status);
  if (parked && Number(parked[1]) !== cycle) {
    throw new Error(`${status} exige cycle: ${parked[1]} (reçu ${cycle})`);
  }
  const steps = [];
  for (let c = 0; c < cycle; c += 1) {
    const full = lineage('FINISHED');
    steps.push(...(c === 0 ? full : full.slice(1)), `RETOUR${c + 1}`);
  }
  if (!parked) {
    const current = lineage(status, parentOverrides);
    steps.push(...(cycle > 0 ? current.slice(1) : current));
  }

  // Un pas toutes les 45 min, deux jours avant chaque retour ; le dernier pas
  // tombe 45 min avant maintenant. L'ordre chronologique est ce que lit la timeline.
  let t = 0;
  const offsets = steps.map((s, i) => {
    if (i > 0) t += RETOUR_STATUS.test(s) ? RETOUR_GAP_MS : STEP_MS;
    return t;
  });
  const start = now.getTime() - STEP_MS - t;
  return steps.map((s, i) => ({ status: s, at: new Date(start + offsets[i]) }));
}

/** Découpe l'historique par cycle : `cycles[c][0]` est l'entrée RETOURc pour c ≥ 1. */
function splitCycles(history) {
  const cycles = [[]];
  for (const h of history) {
    if (RETOUR_STATUS.test(h.status)) cycles.push([]);
    cycles[cycles.length - 1].push(h);
  }
  return cycles;
}

/** `JJ-MM-AAAA_HH-mm-ss` à l'heure de Tunis — format des noms de documents Drive. */
function tunisStamp(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Africa/Tunis',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}-${p.month}-${p.year}_${p.hour}-${p.minute}-${p.second}`;
}

/** Étape pendant laquelle chaque document est déposé. */
const DOC_GATE = { Devis: 'WAITING_DEVIS', BC: 'WAITING_BC', BL: 'WAITING_BL', Facture: 'WAITING_FACTURE' };

/** Horodatage de dépôt de chaque document d'un cycle, lu dans ses propres étapes. */
function stampsFor(entries, entity) {
  const last = entries[entries.length - 1]?.at ?? new Date();
  return (kind) => {
    const gate = entries.find((h) => h.status === DOC_GATE[kind]);
    return { entity, at: new Date((gate?.at ?? last).getTime() + DOC_OFFSET_MS) };
  };
}

/** Un document Drive factice, à la forme attendue par `maybeAdvanceDocGate`. */
const doc = (kind, id, stamp) => ({
  driveFileId: `qa-${kind.toLowerCase()}-${id}`,
  webViewLink: `https://example.invalid/${kind.toLowerCase()}/${id}`,
  name: stamp
    ? `${stamp.entity}_${kind}_${tunisStamp(stamp.at)}.pdf`
    : `${kind.toLowerCase()}-${id}.pdf`,
});

/**
 * Documents déjà présents à ce stade du flux. Les portes documentaires avancent
 * à l'UPLOAD (`maybeAdvanceDocGate`) : une DI garée APRÈS une porte doit donc
 * porter le document qui l'a fait avancer, sinon son état est incohérent et la
 * porte suivante ne peut pas être testée.
 */
function docsFor(status, id, stampOf = () => undefined) {
  const one = (kind) => ({ [kind]: doc(kind, id, stampOf(kind)) });
  switch (status) {
    case 'WAITING_BC':
      return { ...one('Devis') };
    case 'NEGOTIATION2':
    case 'PENDING3':
    case 'CONFIRMATION':
    case 'ATTENTE_CONFIRMATION_COORDINATION':
    case 'MAGASIN_FINALISATION':
    case 'REPARATION':
    case 'REPARATION_Pause':
    case 'INREPARATION':
    case 'WAITING_BL':
      return { ...one('Devis'), ...one('BC') };
    case 'WAITING_FACTURE':
      return { ...one('Devis'), ...one('BC'), ...one('BL') };
    case 'FINISHED':
      return { ...one('Devis'), ...one('BC'), ...one('BL'), ...one('Facture') };
    default:
      return {};
  }
}

/**
 * URLs scalaires des documents d'un cycle, telles que `writeCurrentCycleDoc` les
 * écrit sur la ligne `logsdis` (le back y pose l'URL en scalaire ET la référence
 * structurée dans `driveDocs`). Sans elles, la modale « Affectation des Fichiers »
 * n'a rien à montrer ni en « Fichiers principaux » ni dans la frise.
 */
function docScalarsFor(docs) {
  const map = { Devis: 'devis', BC: 'bon_de_commande', BL: 'bon_de_livraison', Facture: 'facture' };
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
 * Construit le triplet {di, stat, logs} d'un scénario, plus `extraStats` (une Stat
 * par cycle clos) et `events` (un `DI_RETOUR_n` par retour).
 *
 * @param spec.id        `_id` de la DI (préfixé, cf. PREFIX du script appelant)
 * @param spec.idnum     référence humaine affichée (hors format compteur `T{n}`)
 * @param spec.status    statut visé ; `RETOURn` = retour ouvert, en attente (cycle = n)
 * @param spec.cycle     `ignoreCount` : 0 = flux original, ≥ 1 = retour
 * @param spec.rep       `can_be_repaired`
 * @param spec.pdr       `contain_pdr`
 * @param spec.fixtronix `isErrorFromFixtronix` — `null` = verdict NON tranché
 * @param spec.payant    `diagnosticPayant`
 * @param spec.comps     composants du cycle (défaut : ceux des refs si `pdr`)
 * @param spec.money     pose les montants des cycles tarifés (défaut : non)
 */
export function buildDiTriple(spec, refs, now = new Date()) {
  const {
    id, idnum, title, next, status, cycle = 0,
    rep = true, pdr = false, fixtronix = false, payant = true,
    comps, role = 'Tech', parentOverrides, extra = {}, money = false,
  } = spec;

  // Retour ouvert (RETOURn) : le miroir de la DI vient d'être remis à zéro
  // (RETOUR_CYCLE_RESET, di.service.ts) — aucun verdict, aucune pièce, aucun document.
  const parked = RETOUR_STATUS.test(status);

  // Non réparable ⇒ aucune pièce (règle métier) ; PDR ⇒ au moins une pièce, car
  // `contain_pdr: true` avec `array_composants: []` est REFUSÉ par le serveur
  // (« PDR déclaré sans composant », di.diagnostic-routing.spec.ts).
  const composants = parked
    ? []
    : comps !== undefined ? comps : pdr && rep ? refs.composants.slice(0, 1) : [];
  const overrides = { ...(pdr && rep ? PDR_PATH : {}), ...(parentOverrides ?? {}) };
  const history = buildHistory(status, cycle, now, overrides);
  const cycles = splitCycles(history);
  const current = cycles[cycle];
  const statusUpdatedAt = history[history.length - 1]?.at ?? now;
  const createdAt = history[0]?.at ?? now;
  const cycleOpenedAt = current[0]?.at ?? createdAt;
  const retourAt = (n) => cycles[n]?.[0]?.at ?? createdAt;
  const entity = refs.docEntity ?? 'CLIENT';
  const docId = (c) => `${idnum}-c${c}`;

  // Argent du cycle courant : prix posé à « Valider le prix » (WAITING_DEVIS
  // atteint), prix final confirmé après le BC.
  const reached = (s) => current.some((h) => h.status === s);
  const pricedNow = money && reached('WAITING_DEVIS');
  const finalNow = money && reached('WAITING_BC') && status !== 'WAITING_BC';
  const diagPrice = payant ? MONEY.diag : 0;
  const finalPrice = diagPrice + MONEY.repair;

  const verdict = parked
    ? {
        can_be_repaired: null,
        contain_pdr: false,
        array_composants: [],
        di_category_id: refs.categoryId,
        remarque_tech_diagnostic: null,
        isErrorFromFixtronix: null,
      }
    : {
        can_be_repaired: rep,
        contain_pdr: pdr,
        array_composants: composants,
        di_category_id: refs.categoryId,
        remarque_tech_diagnostic: `Diagnostic de démonstration — ${title}`,
        // Le verdict Fixtronix n'a de sens qu'en retour, et `null` signifie
        // « le technicien n'a pas encore tranché » (l'état réel avant saisie).
        ...(cycle > 0 && fixtronix !== null ? { isErrorFromFixtronix: fixtronix } : {}),
      };

  const currentDocs = parked ? {} : docsFor(status, docId(cycle), stampsFor(current, entity));

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
    isPdr: parked ? null : pdr,
    isReparable: parked ? null : rep,
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
    // Argent : au cycle 0 il vit sur la DI ; en retour il vit sur la ligne du
    // cycle, seule l'estimation de réparation reste sur la DI (setRepairEstimate).
    repairEstimate: pricedNow ? MONEY.repair : null,
    diagnosticEstimate: null,
    price: cycle === 0 && pricedNow ? diagPrice : null,
    final_price: cycle === 0 && finalNow ? finalPrice : null,
    driveDocs: currentDocs,
    ...docScalarsFor(currentDocs),
    retourReason: cycle > 0 ? RETOUR_REASONS[cycle - 1] : null,
    retourDate: cycle > 0 ? retourAt(cycle) : null,
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

  const statBase = {
    _idDi: id,
    diRef: id,
    id_tech_diag: refs.techId,
    id_tech_rep: refs.techId,
    location_id: refs.locationName,
    diagRunStartedAt: null,
    repRunStartedAt: null,
    pauseLogs: [],
    diagSegments: [],
    repSegments: [],
    diagAssignments: [],
  };

  // Retour ouvert : la Stat du nouveau cycle n'existe pas encore (créée à
  // l'affectation technicien) — sinon la DI apparaîtrait dans la file du tech.
  const stat = parked
    ? null
    : {
        ...statBase,
        _id: `stat-${id}`,
        // MIROIR obligatoire : c'est ce champ que la liste technicien filtre.
        status,
        diag_time: status === 'DIAGNOSTIC' || status === 'PENDING1' || status === 'CREATED' ? '' : '00:12:30',
        rep_time: REPAIR_STATUSES.has(status) ? '00:21:00' : '',
        ignoreCount: cycle,
        retour_count: cycle,
        createdAt: cycleOpenedAt,
        updatedAt: statusUpdatedAt,
      };

  // Une Stat par cycle CLOS : elle garde FINISHED, comme en base.
  const extraStats = [];
  for (let c = 0; c < cycle; c += 1) {
    const entries = cycles[c];
    extraStats.push({
      ...statBase,
      _id: `stat-${id}-c${c}`,
      status: 'FINISHED',
      diag_time: '00:12:30',
      rep_time: '00:21:00',
      ignoreCount: c,
      retour_count: c,
      createdAt: entries[0].at,
      updatedAt: entries[entries.length - 1].at,
    });
  }

  // Une ligne par cycle. Les cycles antérieurs sont CLOS à la date du retour
  // suivant, avec leurs 4 documents et leur argent reporté ; seul le cycle
  // courant porte le verdict vivant.
  const logs = [];
  for (let c = 0; c <= cycle; c += 1) {
    const entries = cycles[c];
    const isCurrent = c === cycle;
    const openedAt = entries[0]?.at ?? createdAt;
    const closedAt = isCurrent ? null : retourAt(c + 1);
    const rowStatus = isCurrent ? status : 'FINISHED';
    const rowDocs = isCurrent ? currentDocs : docsFor('FINISHED', docId(c), stampsFor(entries, entity));
    const rowMoney = !money
      ? {}
      : !isCurrent
        ? { price: MONEY.diag, final_price: MONEY.diag + MONEY.repair, ...(c === 0 ? { repairEstimate: MONEY.repair } : {}) }
        : c > 0
          ? { ...(pricedNow ? { price: diagPrice } : {}), ...(finalNow ? { final_price: finalPrice } : {}) }
          : {};
    logs.push({
      _id: `log-${id}-${c}`,
      _idDi: id,
      idIgnore: c,
      ...(isCurrent
        ? verdict
        : {
            can_be_repaired: true,
            contain_pdr: false,
            array_composants: [],
            isErrorFromFixtronix: false,
            remarque_tech_diagnostic: `Cycle ${c} — diagnostic terminé`,
            remarque_tech_repair: `Cycle ${c} — réparation terminée et testée`,
          }),
      status: rowStatus,
      // Les documents appartiennent au CYCLE, pas à la DI : `documents[]` est
      // dérivé du `driveDocs` de la ligne (withCycleDocuments), l'URL scalaire
      // sert à la modale « Affectation des Fichiers » (cycle 0 = fichiers principaux).
      driveDocs: rowDocs,
      ...docScalarsFor(rowDocs),
      ...rowMoney,
      ...(c > 0 ? { retourReason: RETOUR_REASONS[c - 1], retourDate: retourAt(c) } : {}),
      current_workers_ids: [refs.techId],
      current_roles: [role],
      isDeleted: false,
      openedAt,
      ...(closedAt ? { closedAt } : {}),
      createdAt: openedAt,
      updatedAt: closedAt ?? statusUpdatedAt,
    });
  }

  // Journal : le motif du bandeau « Retour n » est lu dans `payload.reason`.
  const events = [];
  for (let n = 1; n <= cycle; n += 1) {
    events.push({
      type: `DI_RETOUR_${n}`,
      diId: id,
      actorId: refs.adminId ?? null,
      actorRole: refs.adminId ? 'ADMIN_MANAGER' : null,
      message: `Retour ${n} (${idnum})`,
      payload: { level: n, reason: RETOUR_REASONS[n - 1], status: `RETOUR${n}` },
      createdAt: retourAt(n),
      __v: 0,
    });
  }

  return { di, stat, logs, extraStats, events };
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

/**
 * Écrit un triplet. Purge d'abord : les index uniques rejetteraient un re-seed.
 * `stat` peut être nul (retour ouvert, pas encore affecté).
 */
export async function writeTriple(db, { di, stat, logs }) {
  await db.collection('dis').deleteOne({ _id: di._id });
  await db.collection('stats').deleteMany({ _idDi: di._id });
  await db.collection('logsdis').deleteMany({ _idDi: di._id });
  await db.collection('dis').insertOne(di);
  if (stat) await db.collection('stats').insertOne(stat);
  if (logs.length) await db.collection('logsdis').insertMany(logs);
}

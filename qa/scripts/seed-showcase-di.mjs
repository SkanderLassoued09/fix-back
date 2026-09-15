#!/usr/bin/env node
/**
 * DI VITRINE — une seule DI dont TOUTES les sections du modal « Dossier »
 * (`di-info-modal`) sont remplies, pour la regarder à la main.
 *
 * Histoire racontée : le technicien A démarre le diagnostic, fait une pause,
 * reprend puis ABANDONNE (motif) ; la coordinatrice RÉAFFECTE au technicien B,
 * qui termine le diagnostic et la réparation. Parcours complet jusqu'à FINISHED
 * (cycle 0, aucun retour) avec photo réelle, Devis/BC/BL/Facture, composants,
 * les 7 remarques + commentaire, prix, drapeaux et jalons.
 *
 *   node scripts/seed-showcase-di.mjs               # purge → (upload photo) → seed
 *   node scripts/seed-showcase-di.mjs --clean       # purge seule
 *   node scripts/seed-showcase-di.mjs --reupload    # force un nouvel upload de la photo
 *   node scripts/seed-showcase-di.mjs --photo=/chemin/image.jpg
 *
 * Préfixe PROPRE `DI_show_` : `seed-scenarios.mjs` purge tout `DI_scn_` à chaque
 * exécution et effacerait la vitrine.
 *
 * Fichiers : Devis/BC/BL/Facture RÉUTILISENT les fichiers Drive d'une DI réelle
 * (liens qui s'ouvrent). La photo, elle, doit être une vraie image — les « photos »
 * Drive existantes sont des PDF, que `<img>` n'affiche pas — donc elle est
 * UPLOADÉE par la vraie mutation `updateDiInfo` (backend :3000 requis), puis
 * conservée d'une exécution à l'autre pour ne pas créer un fichier Drive par run.
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildDiTriple, purgeSeed, resolveRefs, writeTriple } from '../utils/di-seed.mjs';

const require = createRequire(import.meta.url);
const { MongoClient, ObjectId } = require('mongodb');
const HERE = dirname(fileURLToPath(import.meta.url));

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const GRAPHQL_URL = `${API_URL}/graphql`;
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:4200';

const PREFIX = 'DI_show_';
const DI_ID = `${PREFIX}abandon`;
const IDNUM = 'SHOW-01';

const argv = process.argv.slice(2);
const CLEAN = argv.includes('--clean');
const REUPLOAD = argv.includes('--reupload');
const PHOTO = resolve(
  (argv.find((a) => a.startsWith('--photo=')) ?? '').slice(8)
    || join(HERE, '..', '..', '..', 'fix-front', 'src', 'assets', 'demo', 'images', 'product', 'black-watch.jpg'),
);

const MOTIF = 'Compétence / spécialité inadaptée';

// ─────────────────────────────────────────────────────────────────────────────
// Outils (copiés de seed-scenarios.mjs, qui ne les exporte pas)
// ─────────────────────────────────────────────────────────────────────────────

function tokenFor(role) {
  let state;
  try {
    state = JSON.parse(readFileSync(join(HERE, '..', '.auth', `${role}.json`), 'utf8'));
  } catch {
    return null;
  }
  return (state.origins?.[0]?.localStorage ?? []).find((e) => e.name === 'token')?.value ?? null;
}

async function gql(query, token, variables) {
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-run': '1', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await resp.json().catch(() => ({}));
  return { data: body.data ?? null, errors: body.errors ?? null };
}

/** Purge du préfixe, audits compris (trace d'édition de `updateDiInfo`). */
async function purgeAll(db) {
  const counts = await purgeSeed(db, PREFIX);
  counts.audits = (await db.collection('audits').deleteMany({ _idDoc: { $regex: `^${PREFIX}` } })).deletedCount;
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Temps : T0 = il y a 6 jours, 08:00 heure de Tunis (UTC+1, sans heure d'été)
// ─────────────────────────────────────────────────────────────────────────────

const TUNIS_OFFSET_MS = 60 * 60 * 1000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function t0() {
  const d = new Date(Date.now() - 6 * DAY);
  d.setUTCHours(7, 0, 0, 0); // 08:00 Tunis
  return d.getTime();
}

/** `YYYY/MM/DD:HH:mm:ss` en heure murale de Tunis — le format réel de `Stat.pauseLogs`. */
function wallClock(date) {
  const d = new Date(date.getTime() + TUNIS_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`
    + `:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Références supplémentaires
// ─────────────────────────────────────────────────────────────────────────────

async function resolveShowcaseRefs(db) {
  const refs = await resolveRefs(db);

  const techs = await db
    .collection('profiles')
    .find({ role: 'TECH', isDeleted: { $ne: true } }, { projection: { username: 1, firstName: 1, lastName: 1 } })
    .sort({ _id: 1 })
    .limit(2)
    .toArray();
  if (techs.length < 2) throw new Error('Il faut au moins 2 profils TECH pour raconter un abandon + réaffectation.');

  // Société avec coordonnées ET dossier Drive (cible de l'upload photo), hors
  // FIXTRONIX elle-même : le bloc Contacts du modal doit être rempli.
  const company = await db.collection('companies').findOne({
    _id: { $ne: 'S0' },
    isDeleted: { $ne: true },
    email: { $nin: ['', null] },
    phone: { $nin: ['', null] },
    driveFolderId: { $nin: ['', null] },
  });
  if (!company) throw new Error('Aucune société avec email + téléphone + dossier Drive.');

  // Documents Drive RÉELS d'une DI qui porte les quatre : les liens s'ouvrent.
  const docsDi = await db.collection('dis').findOne(
    {
      'driveDocs.Devis.driveFileId': { $exists: true },
      'driveDocs.BC.driveFileId': { $exists: true },
      'driveDocs.BL.driveFileId': { $exists: true },
      'driveDocs.Facture.driveFileId': { $exists: true },
      _id: { $not: { $regex: '^DI_(scn|show)' } },
    },
    { projection: { driveDocs: 1 } },
  );
  if (!docsDi) throw new Error('Aucune DI réelle ne porte Devis + BC + BL + Facture sur Drive.');

  const composants = await db
    .collection('composants')
    .find({ isDeleted: { $ne: true }, quantity_stocked: { $gt: 2 } }, { projection: { name: 1, prix_vente: 1 } })
    .limit(2)
    .toArray();

  const nameOf = (p) => [p.firstName, p.lastName].map((s) => (s ?? '').trim()).filter((s) => s && s !== 'null').join(' ')
    || p.username;

  return {
    ...refs,
    companyId: company._id,
    companyName: company.name,
    techA: { id: String(techs[0]._id), username: techs[0].username, name: nameOf(techs[0]) },
    techB: { id: String(techs[1]._id), username: techs[1].username, name: nameOf(techs[1]) },
    realDocs: docsDi.driveDocs,
    realDocsFrom: docsDi._id,
    showComposants: composants.map((c, i) => ({ nameComposant: c.name, quantity: i + 1, isUpdated: false })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Photo : upload réel via `updateDiInfo` (seul chemin qui écrit driveDocs.Image)
// ─────────────────────────────────────────────────────────────────────────────

async function uploadPhoto(db, refs) {
  const token = tokenFor('ADMIN_TECH') ?? tokenFor('ADMIN_MANAGER');
  if (!token) return { warn: 'aucun token dans qa/.auth/ (ADMIN_TECH / ADMIN_MANAGER)' };

  let bytes;
  try {
    bytes = readFileSync(PHOTO);
  } catch {
    return { warn: `photo introuvable : ${PHOTO}` };
  }
  const ext = extname(PHOTO).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;

  // `updateDiInfo` n'accepte qu'une DI CREATED/PENDING1 : on pose un triplet
  // provisoire, on laisse le back uploader, puis on relit la référence Drive.
  const bare = buildDiTriple(
    { id: DI_ID, idnum: IDNUM, title: 'Vitrine — upload photo', next: 'provisoire', status: 'CREATED' },
    refs,
  );
  await writeTriple(db, bare);

  const r = await gql(
    'mutation($input: UpdateDiInfoInput!) { updateDiInfo(input: $input) { _id } }',
    token,
    { input: { _id: DI_ID, image: dataUrl } },
  ).catch((e) => ({ errors: [{ message: `backend injoignable (${e.message})` }] }));

  const after = await db.collection('dis').findOne({ _id: DI_ID }, { projection: { image: 1, driveDocs: 1 } });
  // L'édition émet une trace (system_events / notifications) : hors récit.
  await purgeAll(db);

  if (r.errors?.length) return { warn: `updateDiInfo : ${r.errors[0].message}` };
  if (!after?.driveDocs?.Image?.driveFileId) return { warn: 'upload sans driveDocs.Image en retour' };
  return { image: after.image, Image: after.driveDocs.Image };
}

// ─────────────────────────────────────────────────────────────────────────────
// Le récit
// ─────────────────────────────────────────────────────────────────────────────

function buildShowcase(refs, photo) {
  const T0 = t0();
  const at = (ms) => new Date(T0 + ms);
  const A = refs.techA;
  const B = refs.techB;

  // Parcours copié d'une DI réelle avec PDR (T1469), plus la boucle d'abandon.
  const STEPS = [
    ['CREATED', 0],
    ['PENDING1', 10 * MIN],
    ['DIAGNOSTIC', 30 * MIN], // affectation A
    ['INDIAGNOSTIC', 45 * MIN],
    ['DIAGNOSTIC_Pause', 105 * MIN],
    ['INDIAGNOSTIC', 135 * MIN],
    ['PENDING1', 165 * MIN], // abandon A
    ['DIAGNOSTIC', 210 * MIN], // réaffectation B
    ['INDIAGNOSTIC', 240 * MIN],
    ['DIAGNOSTIC_Pause', 280 * MIN],
    ['INDIAGNOSTIC', 305 * MIN],
    ['DIAGNOSTIC_Pause', 335 * MIN],
    ['INDIAGNOSTIC', 345 * MIN],
    ['MagasinEstimation', 365 * MIN],
    ['PENDING2', 390 * MIN],
    ['PRICING_DIAG', 420 * MIN],
    ['WAITING_DEVIS', DAY + 1 * HOUR],
    ['WAITING_BC', DAY + 6 * HOUR],
    ['CONFIRMATION', 2 * DAY + 1 * HOUR],
    ['ATTENTE_CONFIRMATION_COORDINATION', 2 * DAY + 2 * HOUR],
    ['MAGASIN_FINALISATION', 2 * DAY + 3 * HOUR],
    ['PENDING3', 2 * DAY + 3.5 * HOUR],
    ['REPARATION', 2 * DAY + 5 * HOUR],
    ['INREPARATION', 2 * DAY + 5.25 * HOUR],
    ['REPARATION_Pause', 2 * DAY + 6.75 * HOUR],
    ['INREPARATION', 2 * DAY + 7.5 * HOUR],
    ['REPARATION_Pause', 2 * DAY + 8 * HOUR],
    ['INREPARATION', 2 * DAY + 8 * HOUR + 20 * MIN],
    ['WAITING_BL', 2 * DAY + 8 * HOUR + 35 * MIN],
    ['WAITING_FACTURE', 3 * DAY + 2 * HOUR],
    ['FINISHED', 3 * DAY + 7 * HOUR],
  ];
  const statusHistory = STEPS.map(([status, ms]) => ({ status, at: at(ms) }));
  const created = at(0);
  const finished = at(3 * DAY + 7 * HOUR);

  const abandonAt = at(165 * MIN);
  const reassignAt = at(210 * MIN);
  const pricingRequestAt = at(390 * MIN);
  const confirmedAt = at(2 * DAY + 3 * HOUR);

  // Segments : Σ diag = A (60 + 30) + B (40 + 30 + 20) = 180 min = diag_time ;
  // Σ rép = 90 + 30 + 15 = 135 min = rep_time. Pauses : 3 en diagnostic (30, 25,
  // 10 min), 2 en réparation (45, 20 min) — chacune bornée par l'historique.
  // Le 2ᵉ segment de A s'arrête PILE à l'abandon → libellé « Abandon — A (motif) ».
  const seg = (from, to) => ({ startedAt: at(from), stoppedAt: at(to), _id: new ObjectId() });
  const diagSegments = [
    seg(45 * MIN, 105 * MIN),
    seg(135 * MIN, 165 * MIN),
    seg(240 * MIN, 280 * MIN),
    seg(305 * MIN, 335 * MIN),
    seg(345 * MIN, 365 * MIN),
  ];
  const repSegments = [
    seg(2 * DAY + 5.25 * HOUR, 2 * DAY + 6.75 * HOUR),
    seg(2 * DAY + 7.5 * HOUR, 2 * DAY + 8 * HOUR),
    seg(2 * DAY + 8 * HOUR + 20 * MIN, 2 * DAY + 8 * HOUR + 35 * MIN),
  ];
  const pause = (pauseType, from, to) => ({
    pauseType,
    pauseStart: wallClock(at(from)),
    pauseEnd: wallClock(at(to)),
    _id: new ObjectId(),
  });
  const pauseLogs = [
    pause('diag', 105 * MIN, 135 * MIN),
    pause('diag', 280 * MIN, 305 * MIN),
    pause('diag', 335 * MIN, 345 * MIN),
    pause('rep', 2 * DAY + 6.75 * HOUR, 2 * DAY + 7.5 * HOUR),
    pause('rep', 2 * DAY + 8 * HOUR, 2 * DAY + 8 * HOUR + 20 * MIN),
  ];

  const stamp = (d) => {
    const x = new Date(d.getTime() + TUNIS_OFFSET_MS);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(x.getUTCDate())}-${p(x.getUTCMonth() + 1)}-${x.getUTCFullYear()}_${p(x.getUTCHours())}-${p(x.getUTCMinutes())}-00`;
  };
  const entity = String(refs.companyName).trim().replace(/\s+/g, '_');
  const realDoc = (kind, when) => ({
    driveFileId: refs.realDocs[kind].driveFileId,
    webViewLink: refs.realDocs[kind].webViewLink,
    name: `${entity}_${kind}_${stamp(when)}.pdf`,
  });
  const cycleDocs = {
    Devis: realDoc('Devis', at(DAY + 6 * HOUR)),
    BC: realDoc('BC', at(2 * DAY + 1 * HOUR)),
    BL: realDoc('BL', at(3 * DAY + 2 * HOUR)),
    Facture: realDoc('Facture', at(3 * DAY + 6 * HOUR)),
  };
  const docScalars = {
    devis: cycleDocs.Devis.webViewLink,
    bon_de_commande: cycleDocs.BC.webViewLink,
    bon_de_livraison: cycleDocs.BL.webViewLink,
    facture: cycleDocs.Facture.webViewLink,
  };

  const title = 'Variateur de fréquence ABB ACS580 — défaut surintensité F0001';
  const description = [
    'Variateur ABB ACS580-01-12A7-4 (5,5 kW) déposé par le client après arrêts répétés de la ligne d\'embouteillage n°2.',
    'Symptômes signalés : défaut F0001 « Surintensité » au démarrage moteur, ventilateur interne bruyant, odeur de brûlé légère.',
    'Contexte : panne apparue après une coupure réseau ; le variateur a été réarmé 3 fois sur site sans succès.',
    'Accessoires fournis : panneau de commande ACS-AP-S, câble USB, notice. Demande : diagnostic complet + devis de réparation.',
  ].join('\n');

  // Textes du CYCLE : le modal lit la ligne logsdis du cycle, sans repli DI.
  const texts = {
    remarque_manager: 'Client prioritaire (contrat de maintenance annuel). Délai demandé : 5 jours ouvrés.',
    remarque_admin_manager: 'Devis validé par le service achat du client — BC reçu le jour même.',
    remarque_admin_tech: 'Réaffectation à un technicien habilité variateurs de puissance après l\'abandon du premier diagnostic.',
    // Format RÉEL du formulaire de diagnostic : description de la panne, puis la
    // remarque technicien derrière ce séparateur (fix-front remarque-diagnostic.util.ts).
    remarque_tech_diagnostic: [
      'Pont IGBT phase V en court-circuit (mesure diode 0,02 V), condensateur de bus DC gonflé (C12), ventilateur grippé.',
      'Carte de commande saine, alimentation 24 V OK.',
    ].join('\n')
      + '\n\nRemarque technicien :\n'
      + 'Réparable : remplacement module IGBT + condensateur + ventilateur. Prévoir un essai en charge de 2 h.',
    remarque_tech_repair: [
      'Module IGBT et condensateur C12 remplacés, ventilateur neuf monté, pâte thermique refaite.',
      'Essai en charge 2 h sur moteur 4 kW : aucun défaut, température radiateur 52 °C max. Paramètres client restaurés.',
    ].join('\n'),
    remarque_magasin: 'Condensateur et ventilateur sortis du stock ; module IGBT réservé sur l\'arrivage du fournisseur.',
    remarque_coordinator: 'Composants confirmés avec le magasin, client informé du délai supplémentaire de 24 h.',
    comment: 'Prévoir un contrôle préventif des 2 autres variateurs identiques de la ligne lors de la livraison.',
  };

  const handshake = {
    isSentToCoordinator: true,
    isConfirmedComponentFromCoordinator: true,
    handleSendingNotificationBetweenCoordinatorAndMagasin: 'IN_COORDINATOR',
    gotComposantFromMagasin: true,
    needsDevisBeforeRepair: true,
    pricingRequestSentAt: pricingRequestAt,
    pricingRequestSentBy: refs.adminId,
    componentsConfirmedAt: confirmedAt,
    componentsConfirmedBy: refs.coordinatorId,
    stockDecrementedAt: confirmedAt,
  };

  const triple = buildDiTriple(
    {
      id: DI_ID,
      idnum: IDNUM,
      title,
      next: description,
      status: 'FINISHED',
      rep: true,
      pdr: true,
      comps: refs.showComposants,
      role: 'Coordinator',
      extra: {
        nSerie: '3AXD50000731121',
        dateReception: created,
        ...texts,
        ...handshake,
        isErrorFromFixtronix: false,
        isOpenedOnce: true,
        current_workers_ids: [B.id],
        diagnosticPayant: true,
        diagnosticEstimate: 150,
        price: 180,
        repairEstimate: 950,
        final_price: 1130,
        discount: 5,
        discount_value: 56.5,
        type_client: 'Company',
        service_quality: 'Excellente',
        image: photo?.image ?? '',
        driveDocs: { ...(photo?.Image ? { Image: photo.Image } : {}), ...cycleDocs },
        ...docScalars,
        statusHistory,
        statusUpdatedAt: finished,
        createdAt: created,
        updatedAt: finished,
      },
    },
    refs,
  );

  Object.assign(triple.stat, {
    id_tech_diag: B.id,
    id_tech_rep: B.id,
    diag_time: '03:00:00',
    rep_time: '02:15:00',
    diagnostiquefinishedFLAG: true,
    reperationfinishedFLAG: true,
    pauseLogs,
    diagSegments,
    repSegments,
    diagAssignments: [
      {
        tech: A.id,
        assignedAt: at(30 * MIN),
        abandonedAt: abandonAt,
        motif: MOTIF,
        abandonedBy: A.username,
        diagTimeStart: '00:00:00',
        diagTime: '01:30:00',
        _id: new ObjectId(),
      },
      {
        tech: B.id,
        assignedAt: reassignAt,
        abandonedAt: null,
        motif: null,
        abandonedBy: null,
        diagTimeStart: '01:30:00',
        diagTime: null,
        _id: new ObjectId(),
      },
    ],
    createdAt: at(30 * MIN),
    updatedAt: finished,
  });

  // Ligne du cycle 0 : même verdict, textes, drapeaux et documents (photo exclue,
  // elle vit au niveau DI). Montants laissés sur la DI, comme l'app au cycle 0.
  Object.assign(triple.logs[0], {
    ...texts,
    ...handshake,
    isErrorFromFixtronix: false,
    isOpenedOnce: true,
    driveDocs: cycleDocs,
    ...docScalars,
    current_workers_ids: [B.id],
    reconstructed: false,
    closedAt: null,
    openedAt: created,
    createdAt: created,
    updatedAt: finished,
  });

  const ev = (type, when, message, payload, actor = null) => ({
    type,
    diId: DI_ID,
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    message,
    payload,
    createdAt: when,
    __v: 0,
  });
  const admin = refs.adminId ? { id: refs.adminId, role: 'ADMIN_MANAGER' } : null;
  const coord = refs.coordinatorId ? { id: refs.coordinatorId, role: 'COORDIANTOR' } : null;
  const events = [
    ev('DI_ASSIGNED_DIAG', at(30 * MIN), `Nouvelle DI affectée en diagnostic (${IDNUM})`,
      { status: 'DIAGNOSTIC', techId: A.id }, coord),
    ev('DI_ABANDONED', abandonAt, `${A.username} a annulé la DI ${IDNUM} — à réaffecter (${MOTIF})`,
      { status: 'PENDING1' }, { id: A.id, role: 'TECH' }),
    ev('DI_ASSIGNED_DIAG', reassignAt, `Nouvelle DI affectée en diagnostic (${IDNUM})`,
      { status: 'DIAGNOSTIC', techId: B.id }, coord),
    ev('DI_MAGASIN_ESTIMATION', at(365 * MIN), `DI ${IDNUM} — estimation des composants par le magasin`,
      { status: 'MagasinEstimation' }, { id: B.id, role: 'TECH' }),
    ev('DI_PENDING2', at(390 * MIN), `DI ${IDNUM} — en attente de tarification`, { status: 'PENDING2' }),
    ev('DI_DOC_DEVIS', at(DAY + 6 * HOUR), `DI ${IDNUM} — devis ajouté (à vérifier), en attente de BC`,
      { doc: 'Devis' }, admin),
    ev('DI_DOC_BC', at(2 * DAY + 1 * HOUR), `DI ${IDNUM} — bon de commande ajouté (à vérifier)`, { doc: 'BC' }, admin),
    ev('DI_ASSIGNED_REP', at(2 * DAY + 5 * HOUR), `Nouvelle DI affectée en réparation (${IDNUM})`,
      { status: 'REPARATION', techId: B.id }, coord),
    ev('DI_DOC_BL', at(3 * DAY + 2 * HOUR), `DI ${IDNUM} — bon de livraison ajouté`, { doc: 'BL' }, admin),
    ev('DI_FINISHED', finished, `DI ${IDNUM} clôturée`, { status: 'FINISHED' }, admin),
  ];

  return { triple, events };
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(MONGO_DB);

  try {
    // 1) Photo déjà uploadée par un run précédent : on la garde.
    const previous = await db.collection('dis').findOne({ _id: DI_ID }, { projection: { image: 1, driveDocs: 1 } });
    const kept = previous?.driveDocs?.Image?.driveFileId
      ? { image: previous.image, Image: previous.driveDocs.Image }
      : null;

    // 2) Purge.
    const purged = await purgeAll(db);
    if (CLEAN) {
      console.log(`\nNettoyage (base ${MONGO_DB}) — ${JSON.stringify(purged)}`);
      if (kept) console.log(`  Photo laissée sur Drive : ${kept.image}`);
      return;
    }

    // 3) Références.
    const refs = await resolveShowcaseRefs(db);

    // 4) Photo.
    let photo = REUPLOAD ? null : kept;
    let photoNote = photo ? 'réutilisée (run précédent)' : '';
    if (!photo) {
      const up = await uploadPhoto(db, refs);
      if (up.warn) {
        photoNote = `⚠ non uploadée — ${up.warn}`;
      } else {
        photo = up;
        photoNote = 'uploadée sur Drive';
      }
    }

    // 5-7) Récit complet.
    const { triple, events } = buildShowcase(refs, photo);
    await writeTriple(db, triple);
    await db.collection('system_events').insertMany(events);

    console.log(`\n════════ DI VITRINE seedée dans ${MONGO_DB} ════════`);
    console.log(`  ${IDNUM}  (${DI_ID})  — FINISHED, cycle 0`);
    console.log(`  Société       : ${refs.companyName}`);
    console.log(`  Technicien A  : ${refs.techA.name} (@${refs.techA.username}) — ABANDON (« ${MOTIF} »)`);
    console.log(`  Technicien B  : ${refs.techB.name} (@${refs.techB.username}) — réaffecté, diag + réparation`);
    console.log(`  Photo         : ${photoNote}${photo ? ` — ${photo.Image.driveFileId}` : ''}`);
    console.log(`  Documents     : Devis/BC/BL/Facture réutilisés de ${refs.realDocsFrom}`);
    console.log(`  Composants    : ${refs.showComposants.map((c) => `${c.nameComposant} ×${c.quantity}`).join(', ')}`);
    console.log(`  Événements    : ${events.length}`);
    console.log(`\n  Ouvrir (ADMIN_MANAGER / ADMIN_TECH / MANAGER) :`);
    console.log(`  ${FRONT_URL}/tickets/ticket/ticket-list?di=${DI_ID}&action=detail`);
    console.log(`\nNettoyage : node scripts/seed-showcase-di.mjs --clean\n`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error('ERREUR seed vitrine :', e?.stack ?? e?.message ?? e);
  process.exit(1);
});

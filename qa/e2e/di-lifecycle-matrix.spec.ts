import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';

/**
 * MATRICE DE CYCLE DE VIE — sortie de diagnostic, TOUTES combinaisons.
 * Réparable / non réparable × PDR / sans PDR × payant / non payant × flux
 * ORIGINAL (ignoreCount=0) / RETOUR (ignoreCount>0) × verdict « erreur
 * Fixtronix » en retour. Test auto-suffisant au niveau API : seed direct
 * (DI + Stat + LogsDi de cycle pour le retour), appel de la MÊME mutation que
 * le front, assertion sur le statut obtenu. Nettoyage exhaustif en fin.
 *
 * Le routage a été cartographié end-to-end (front handler → mutation → service).
 * En RETOUR, le routage lit le SNAPSHOT DU CYCLE (LogsDi {_idDi, idIgnore}),
 * pas la DI vive — d'où le seed d'un LogsDi pour les cas 6-9.
 */

const P = 'di-lcm-e2e-'; // prefix
const ALL: string[] = [];

async function seed(opts: {
  key: string;
  ignoreCount?: number;
  can_be_repaired: boolean;
  contain_pdr?: boolean;
  diagnosticPayant?: boolean;
  composants?: boolean;
  /** Statut de départ (défaut INDIAGNOSTIC) — MagasinEstimation pour la SORTIE magasin. */
  status?: string;
  /** Verdict Fixtronix PERSISTANT sur la DI (survit au clobber du formulaire). */
  fixtronixOnDi?: boolean;
  log?: { contain_pdr: boolean; composants: boolean; fixtronix: boolean };
}): Promise<string> {
  const _id = P + opts.key;
  ALL.push(_id);
  const ignoreCount = opts.ignoreCount ?? 0;
  const comps = opts.composants ? [{ nameComposant: 'Fusible', quantity: 1 }] : [];
  await withDb(async (db) => {
    await db.collection('dis').deleteOne({ _id });
    await db.collection('stats').deleteMany({ _idDi: _id });
    await db.collection('logsdis').deleteMany({ _idDi: _id });
    const now = new Date();
    await db.collection('dis').insertOne({
      _id,
      _idnum: _id,
      title: 'LIFECYCLE MATRIX E2E',
      status: opts.status ?? 'INDIAGNOSTIC',
      ignoreCount,
      can_be_repaired: opts.can_be_repaired,
      contain_pdr: opts.contain_pdr ?? false,
      array_composants: comps,
      ...(opts.fixtronixOnDi ? { isErrorFromFixtronix: true } : {}),
      ...(opts.diagnosticPayant !== undefined
        ? { diagnosticPayant: opts.diagnosticPayant }
        : {}),
      current_roles: [],
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('stats').insertOne({
      _id: `stat-${_id}`,
      _idDi: _id,
      ignoreCount,
      status: opts.status ?? 'INDIAGNOSTIC',
      createdAt: now,
      updatedAt: now,
    });
    // Snapshot LogsDi du cycle courant (routage RETOUR le lit).
    if (opts.log) {
      await db.collection('logsdis').insertOne({
        _id: `log-${_id}`,
        _idDi: _id,
        idIgnore: ignoreCount,
        // Le verdict « réparable » du cycle est écrit sur le log en prod
        // (logsDiService.tech_startDiagnostic) : le routage RETOUR Fixtronix
        // tranche dessus (réparable → PENDING3 ; non réparable → IRREPARABLE).
        can_be_repaired: opts.can_be_repaired,
        contain_pdr: opts.log.contain_pdr,
        array_composants: opts.log.composants
          ? [{ nameComposant: 'Fusible', quantity: 1 }]
          : [],
        isErrorFromFixtronix: opts.log.fixtronix,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  return _id;
}

async function statusOf(_id: string): Promise<string | undefined> {
  return withDb(async (db) => {
    const di = await db.collection('dis').findOne({ _id }, { projection: { status: 1 } });
    return di?.status;
  });
}

const toFinish = (id: string) =>
  `mutation { changestatusToFinishReparation(_id: "${id}") { _id status } }`;
const magasinEstim = (id: string) =>
  `mutation { changeStatusMagasinEstimation(_id: "${id}") }`;
const pending2 = (id: string) => `mutation { changeStatusPending2(_id: "${id}") }`;

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteMany({ _id: { $in: ALL } });
    await db.collection('stats').deleteMany({ _idDi: { $in: ALL } });
    await db.collection('logsdis').deleteMany({ _idDi: { $in: ALL } });
    await db.collection('notifications').deleteMany({ diId: { $in: ALL } });
    await db.collection('system_events').deleteMany({ diId: { $in: ALL } });
  });
});

// ───────────────────────── FLUX ORIGINAL (ignoreCount=0) ─────────────────────
test('01 · ORIGINAL · non réparable · PAYANT → PENDING2 (facturer le diagnostic)', async ({ request }) => {
  const id = await seed({ key: 'o-nr-pay', can_be_repaired: false, diagnosticPayant: true });
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING2');
});

test('02 · ORIGINAL · non réparable · NON PAYANT → IRREPARABLE (direct, sans facturation)', async ({ request }) => {
  const id = await seed({ key: 'o-nr-nonpay', can_be_repaired: false, diagnosticPayant: false });
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
});

test('03 · ORIGINAL · réparable · AVEC PDR → MagasinEstimation', async ({ request }) => {
  const id = await seed({ key: 'o-rep-pdr', can_be_repaired: true, contain_pdr: true, composants: true });
  const r = await gqlPost(request, magasinEstim(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('MagasinEstimation');
});

test('04 · ORIGINAL · réparable · SANS PDR → PENDING2', async ({ request }) => {
  const id = await seed({ key: 'o-rep-nopdr', can_be_repaired: true, contain_pdr: false });
  const r = await gqlPost(request, pending2(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING2');
});

// ───────────────────────── FLUX RETOUR (ignoreCount>0) ───────────────────────
test('05 · RETOUR · non réparable → IRREPARABLE (aucune facturation en retour)', async ({ request }) => {
  const id = await seed({ key: 'r-nr', ignoreCount: 1, can_be_repaired: false });
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
});

test('06 · RETOUR · Fixtronix + SANS PDR + réparable → PENDING3 (direct, non facturé)', async ({ request }) => {
  const id = await seed({
    key: 'r-rep-nopdr-fix', ignoreCount: 1, can_be_repaired: true, contain_pdr: false,
    log: { contain_pdr: false, composants: false, fixtronix: true },
  });
  // Erreur Fixtronix (notre faute) + sans PDR + réparable → envoi DIRECT en
  // réparation (PENDING3), magasin & tarification sautés. Pas de Pricing.
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING3');
});

test('07 · RETOUR · réparable · AVEC PDR → MagasinEstimation', async ({ request }) => {
  const id = await seed({
    key: 'r-rep-pdr', ignoreCount: 1, can_be_repaired: true, contain_pdr: true, composants: true,
    log: { contain_pdr: true, composants: true, fixtronix: false },
  });
  const r = await gqlPost(request, magasinEstim(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('MagasinEstimation');
});

test('08 · RETOUR · réparable · SANS PDR · Fixtronix=NON → PENDING2', async ({ request }) => {
  const id = await seed({
    key: 'r-rep-nopdr-nofix', ignoreCount: 1, can_be_repaired: true, contain_pdr: false,
    log: { contain_pdr: false, composants: false, fixtronix: false },
  });
  const r = await gqlPost(request, pending2(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING2');
});

test('09 · RETOUR · Fixtronix + NON réparable → IRREPARABLE (direct, magasin sauté)', async ({ request }) => {
  const id = await seed({
    key: 'r-fix-nrep', ignoreCount: 1, can_be_repaired: false, contain_pdr: false, composants: false,
    log: { contain_pdr: false, composants: false, fixtronix: true },
  });
  // « Pas de PDR si non réparable » → clôture IRREPARABLE DIRECTE, on saute le
  // magasin.
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
});

test('10 · RETOUR · NON réparable même avec PDR déclaré → IRREPARABLE direct (magasin sauté), AUCUNE facturation', async ({ request }) => {
  const id = await seed({
    key: 'r-nrep-pdr-direct', ignoreCount: 1, can_be_repaired: false, contain_pdr: true, composants: true,
    log: { contain_pdr: true, composants: true, fixtronix: false },
  });
  // Backstop serveur : appel direct à changeStatusMagasinEstimation sur une DI
  // NON réparable → IRREPARABLE (on saute le magasin), quel que soit le PDR
  // déclaré (« pas de PDR si non réparable »). Non facturé.
  const r = await gqlPost(request, magasinEstim(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
  const di = await withDb((db) =>
    db.collection('dis').findOne({ _id: id }, { projection: { price: 1, final_price: 1 } }),
  );
  expect(Number(di?.price ?? 0)).toBe(0);
  expect(Number(di?.final_price ?? 0)).toBe(0);
});

// ─── RÈGLE COURANTE (retour) :
//   NON réparable → IRREPARABLE direct (magasin sauté, « pas de PDR si non
//     réparable »).
//   RÉPARABLE + AVEC PDR → magasin (MagasinEstimation) → … → PENDING3.
//   RÉPARABLE + SANS PDR + erreur Fixtronix → PENDING3 direct (non facturé).
//   RÉPARABLE + SANS PDR + erreur client → PENDING2 → Pricing (« facturer le
//     diag ? » y est décidé).
test('11 · RETOUR · Fixtronix + PDR + réparable → MagasinEstimation (passe par le magasin)', async ({ request }) => {
  const id = await seed({
    key: 'r-fix-rep-pdr', ignoreCount: 1, can_be_repaired: true, contain_pdr: true, composants: true,
    log: { contain_pdr: true, composants: true, fixtronix: true },
  });
  // Fixtronix + AVEC PDR → magasin (MagasinEstimation). Ce test ne prouve que
  // l'ENTRÉE au magasin ; la SORTIE (qui partait en PENDING2 → Pricing, donc
  // FACTURÉE) est couverte par le cas 14 ci-dessous et, de bout en bout, par
  // « FT-04 (2e saut) » dans di-flow-all-ui.spec.ts. (Le raccourci
  // PENDING3-direct ne concerne que le cas SANS PDR.)
  const r = await gqlPost(request, magasinEstim(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('MagasinEstimation');
});

test('12 · RETOUR · Fixtronix=OUI · NON réparable · sans pièce → IRREPARABLE (aucune facturation)', async ({ request }) => {
  const id = await seed({
    key: 'r-fix-nonrep', ignoreCount: 1, can_be_repaired: false, contain_pdr: false, composants: false,
    log: { contain_pdr: false, composants: false, fixtronix: true },
  });
  // Erreur Fixtronix + NON réparable → clôture IRREPARABLE (via le chemin
  // « Envoyer vers finir »).
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
});

test('13 · RETOUR · Fixtronix=OUI · NON réparable · sans PDR · appel DIRECT changeStatusMagasinEstimation → IRREPARABLE (backstop)', async ({ request }) => {
  const id = await seed({
    key: 'r-fix-nonrep-direct', ignoreCount: 1, can_be_repaired: false, contain_pdr: false, composants: false,
    log: { contain_pdr: false, composants: false, fixtronix: true },
  });
  // Backstop serveur-autoritaire : même via un appel direct à
  // changeStatusMagasinEstimation, Fixtronix + sans PDR + non réparable clôture
  // en IRREPARABLE (et ne part pas en PENDING3 comme le cas réparable).
  const r = await gqlPost(request, magasinEstim(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
});

test('14 · RETOUR · Fixtronix + PDR · SORTIE magasin → CONFIRMATION (jamais PENDING2/Pricing)', async ({ request }) => {
  const id = await seed({
    key: 'r-fix-rep-pdr-exit', ignoreCount: 1, can_be_repaired: true, contain_pdr: true, composants: true,
    status: 'MagasinEstimation', fixtronixOnDi: true,
    // Log de cycle CLOBBERÉ à false par le formulaire : le flag DI doit gagner.
    log: { contain_pdr: true, composants: true, fixtronix: false },
  });
  // « Terminer l'estimation » du magasin. Sans garde, ce saut posait PENDING2 →
  // PRICING_DIAG : une erreur Fixtronix (notre faute) FACTURÉE au client. La DI
  // doit repartir vers la poignée de main composants (→ … → PENDING3).
  const r = await gqlPost(request, pending2(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('CONFIRMATION');
  const di: any = await withDb((db) => db.collection('dis').findOne({ _id: id }));
  expect(di?.needsDevisBeforeRepair).toBe(true);
});

test('15 · RETOUR · erreur CLIENT + PDR · SORTIE magasin → PENDING2 (non-régression : le client reste facturé)', async ({ request }) => {
  const id = await seed({
    key: 'r-cli-rep-pdr-exit', ignoreCount: 1, can_be_repaired: true, contain_pdr: true, composants: true,
    status: 'MagasinEstimation',
    log: { contain_pdr: true, composants: true, fixtronix: false },
  });
  const r = await gqlPost(request, pending2(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING2');
});

// ─── Les DEUX boutons de fin de retour mènent au MÊME statut (garde API) ──────
// Le grisage d'un des deux boutons a été retiré : le routage est désormais
// serveur-autoritaire. Ces cas verrouillent les 3 routes qui étaient fausses.
test('16 · RETOUR · NON réparable · via changeStatusPending2 → IRREPARABLE (backstop, jamais PENDING2)', async ({ request }) => {
  const id = await seed({
    key: 'r-nrep-pending2', ignoreCount: 1, can_be_repaired: false, contain_pdr: false,
    log: { contain_pdr: false, composants: false, fixtronix: true },
  });
  const r = await gqlPost(request, pending2(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
});

test('17 · RETOUR · réparable + PDR · via changestatusToFinishReparation → MagasinEstimation (et non IRREPARABLE)', async ({ request }) => {
  const id = await seed({
    key: 'r-rep-pdr-tofinish', ignoreCount: 1, can_be_repaired: true, contain_pdr: true, composants: true,
    log: { contain_pdr: true, composants: true, fixtronix: true },
  });
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('MagasinEstimation');
});

test('18 · RETOUR · réparable + sans PDR + client · via changestatusToFinishReparation → PENDING2 (et non IRREPARABLE)', async ({ request }) => {
  const id = await seed({
    key: 'r-rep-nopdr-tofinish', ignoreCount: 1, can_be_repaired: true, contain_pdr: false,
    log: { contain_pdr: false, composants: false, fixtronix: false },
  });
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING2');
});

/**
 * Migration 016 — importer le fichier de stock « Gestion-de-stocks-Fixplus 2026 »
 * dans le catalogue (`composants` + `composant_categories`).
 *
 * POURQUOI. Le classeur Excel du magasin est désormais la SOURCE DE VÉRITÉ des
 * catégories et des composants. La base n'en contenait que 24 sur 826, sous des
 * catégories saisies à la main.
 *
 * CE QUE ÇA FAIT (onglet « Suivi du Stock », en-tête ligne 3) :
 *   - A Code article · B Référence (= `name`) · C Désignation2 (catégorie +
 *     caractéristiques mêlées : 286 variantes) · D Emplacement · E Stock mini ·
 *     F Stock initial · G Entrée · H Sortie. J (stock final) et K (P.U.) sont
 *     VIDES dans le fichier → aucun prix importé.
 *   - Désignation2 → FAMILLE via une liste ordonnée de regex (1ʳᵉ qui matche).
 *     Les familles existantes sont reprises PAR LIBELLÉ (mêmes `C_Composant<N>`),
 *     les manquantes sont créées au max numérique + 1.
 *   - Références en double (même clé) FUSIONNÉES : 1ʳᵉ ligne pour le nom et le
 *     code, quantités SOMMÉES, stock mini MAX, emplacements joints « / ».
 *   - Clé de rapprochement : NFKC + minuscules + sans aucun blanc.
 *   - Composant vivant existant → `$set` catégorie, quantité (le fichier fait
 *     foi), code_article, emplacement, stock_min ; statut « En stock » UNIQUEMENT
 *     s'il est vide/sentinelle. JAMAIS touchés : nom, prix, package, lien, PDF,
 *     coming_date → aucun renommage, donc aucune cascade vers les DI.
 *   - Référence absente → insertion `Cmp<max+1…>`, statut « En stock », sans prix
 *     (absent ≠ 0 : jamais facturé à 0), `createdAt` DISTINCTS (+1 ms par ligne).
 *   - Composants hors fichier : NON touchés (choix produit). Une référence qui
 *     ne correspond qu'à un composant SUPPRIMÉ est rapportée, pas importée.
 *   - Écriture directe en base → aucune notification Discord par composant.
 *
 * SÉCURITÉ : DRY-RUN par défaut (rapport seul). `--apply` pour écrire.
 * Idempotent : un 2ᵉ passage ne crée rien et ne modifie rien.
 *
 * Run (depuis fix-back/) :
 *   node migrations/016-import-stock-fixplus-2026.mjs "<fichier.xlsx>"
 *   node migrations/016-import-stock-fixplus-2026.mjs "<fichier.xlsx>" --apply
 * Env : MONGO_URL (défaut mongodb://127.0.0.1:27017), MONGO_DB (défaut
 * fixtronixproddb). NB : chaque poste a SA base — lancer sur chacune.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const XLSX_PATH = args.find((a) => !a.startsWith('--'));
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const SHEET = 'Suivi du Stock';

if (!XLSX_PATH) {
  console.error('Usage : node migrations/016-import-stock-fixplus-2026.mjs "<fichier.xlsx>" [--apply]');
  process.exit(1);
}
// La base `fixtronix` existe encore sur le même mongod mais est MORTE.
if (MONGO_DB === 'fixtronix') {
  console.error("Refus : la base « fixtronix » est morte — la base applicative est « fixtronixproddb ».");
  process.exit(1);
}

// ── Familles ────────────────────────────────────────────────────────────────
// Libellés EXACTS des catégories déjà en base (réutilisées) ou à créer.
// Testées sur Désignation2 en MAJUSCULES sans accents ; la 1ʳᵉ qui matche gagne.
const RULES = [
  [/^OPTOCOUPLEUR/, 'Optocoupleur'],
  [/^IGBT/, 'IGBT'],
  [/^MOSFET/, 'MOSFET'],
  [/^(TRIAC|THYRISTOR)/, 'Triac/Thyristor'],
  [/^TRANSISTOR/, 'Transistor'],
  [/^(DIODE|DOUBLE DIODE|PONT|REDRESSEUR|MODULE REDRESSEUR)/, 'Diode/Redresseur'],
  [/^CONDENSATEUR/, 'Condensateur'],
  [/^(RESISTANC|RESEAU DE RESISTANCE)/, 'Résistance'],
  [/^(POTENTIOMETRE|SPECTROL)/, 'Potentiomètre'],
  [/^(THERMISTANCE|THERMISTOR)/, 'Thermistance'],
  [/^VARISTANCE/, 'Varistance'],
  [/^(FUSIBLE|MINIFUSIBLE|PORTE FUSIBLE)/, 'Fusible'],
  [/^MICROCONTROLEUR/, 'Microcontrôleur'],
  [/^(REGULATEUR|CONVERTISSEUR|REFERENCE EN TENSION|CONTROLEUR BOOST)/, 'Régulateur/Convertisseur'],
  // Avant « Circuit intégré » : AMPLIFICATEUR FIBRE OPTIQUE ≠ AMPLIFICATEUR RF.
  [/^(CAPTEUR|AMPLIFICATEUR FIBRE OPTIQUE|LASER)/, 'Capteur'],
  [/^(CIRCUIT|DRIVER|AMPLIFICATEUR|EEPROM|SRAM|S-RAM|INTERRUPTEUR ELECTRONIQUE|INTERRUPTEUR DE PUISSANCE)/, 'Circuit intégré'],
  [/^RELAIS?\b/, 'Relais'],
  [/^LED/, 'LED/Affichage'],
  [/^(CONNECTEUR|SUPPORT CIRCUIT)/, 'Connectique'],
  [/^PILE/, 'Pile/Batterie'],
  [/^(MODULE|FREQUENCE RADIO)/, 'Module'],
  [/^(ROULEMENT|BOUTON|ON\/OFF|MICROSWITCH|TRANSFORMATEUR|COMPOSANT MECANIQUE)/, 'Électromécanique'],
];
const FALLBACK_FAMILY = 'Non catégorisé';
// Lignes sans Désignation2 exploitable, tranchées à la main.
const CODE_OVERRIDES = { P0862: 'Circuit intégré' }; // LNK305PN (LinkSwitch)

const BLANK = new Set(['', 'undefined', 'null', 'NaN']);
const isBlankStr = (v) => v == null || BLANK.has(String(v).trim());

const upperNoAccent = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
const matchKey = (s) => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const labelKey = (s) => String(s).normalize('NFC').trim().toLowerCase();
const cleanName = (s) => String(s).replace(/\s+/g, ' ').trim();
const toNum = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
};

const familyOf = (code, designation) => {
  if (CODE_OVERRIDES[code]) return CODE_OVERRIDES[code];
  const u = upperNoAccent(designation);
  if (!u) return null;
  for (const [rx, family] of RULES) if (rx.test(u)) return family;
  return null;
};

// ── 1. Lecture et fusion du classeur ────────────────────────────────────────
const wb = XLSX.readFile(XLSX_PATH);
const ws = wb.Sheets[SHEET];
if (!ws) {
  console.error(`Onglet « ${SHEET} » introuvable (onglets : ${wb.SheetNames.join(', ')}).`);
  process.exit(1);
}
// range 3 = à partir de la ligne 4 (index 0) ; clés = lettres de colonne.
const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 'A', range: 3, defval: null });

const unmapped = [];
const negative = [];
const groups = new Map(); // clé → pièce fusionnée
for (const r of sheetRows) {
  if (isBlankStr(r.B)) continue; // lignes réservées P0864+ sans référence
  const code = cleanName(r.A ?? '');
  const name = cleanName(r.B);
  let family = familyOf(code, r.C);
  if (!family) {
    unmapped.push(`${code} ${name} — « ${r.C ?? ''} »`);
    family = FALLBACK_FAMILY;
  }
  const rawQty = (toNum(r.F) ?? 0) + (toNum(r.G) ?? 0) - (toNum(r.H) ?? 0);
  if (rawQty < 0) negative.push(`${code} ${name} : ${rawQty} → 0`);
  const qty = Math.max(0, rawQty);
  const stockMin = toNum(r.E);
  const emplacement = isBlankStr(r.D) ? null : cleanName(r.D);

  const key = matchKey(name);
  const g = groups.get(key);
  if (!g) {
    groups.set(key, {
      key,
      name,
      code,
      family,
      qty,
      stockMin,
      emplacements: emplacement ? [emplacement] : [],
      members: [{ code, name, family, designation: r.C, qty, emplacement }],
    });
    continue;
  }
  g.qty += qty;
  if (stockMin != null) g.stockMin = g.stockMin == null ? stockMin : Math.max(g.stockMin, stockMin);
  if (emplacement && !g.emplacements.includes(emplacement)) g.emplacements.push(emplacement);
  g.members.push({ code, name, family, designation: r.C, qty, emplacement });
}
const parts = [...groups.values()];
const merged = parts.filter((p) => p.members.length > 1);
const familyConflicts = merged.filter((p) => new Set(p.members.map((m) => m.family)).size > 1);

const client = new MongoClient(MONGO_URL);
await client.connect();
const db = client.db(MONGO_DB);
const now = Date.now();

try {
  console.log(`== Migration 016 : import stock « ${XLSX_PATH} » → ${MONGO_DB} ==`);
  console.log(APPLY ? '-- APPLY --' : '-- DRY RUN (aucune écriture) --');
  console.log(
    `Classeur : ${sheetRows.filter((r) => !isBlankStr(r.B)).length} lignes avec référence → ${parts.length} pièces distinctes (${merged.length} références fusionnées).`,
  );

  // ── 2. Catégories ─────────────────────────────────────────────────────────
  const categories = await db.collection('composant_categories').find({}).toArray();
  const liveByLabel = new Map();
  for (const c of categories) {
    if (c.isDeleted === true) continue;
    const k = labelKey(c.category_composant);
    if (!liveByLabel.has(k)) liveByLabel.set(k, c._id);
  }
  let maxCatIndex = -1;
  for (const c of categories) {
    const m = /^C_Composant(\d+)$/.exec(String(c._id));
    if (m) maxCatIndex = Math.max(maxCatIndex, Number(m[1]));
  }
  const familyOrder = [...new Set([...RULES.map(([, f]) => f), FALLBACK_FAMILY])];
  const usedFamilies = new Set(parts.map((p) => p.family));
  const categoryIdOf = new Map();
  const categoriesToCreate = [];
  for (const family of familyOrder) {
    if (!usedFamilies.has(family)) continue;
    const existingId = liveByLabel.get(labelKey(family));
    if (existingId) {
      categoryIdOf.set(family, existingId);
      continue;
    }
    maxCatIndex += 1;
    const doc = {
      _id: `C_Composant${maxCatIndex}`,
      category_composant: family,
      isDeleted: false,
      createdAt: new Date(now + categoriesToCreate.length),
      updatedAt: new Date(now + categoriesToCreate.length),
      __v: 0,
    };
    categoriesToCreate.push(doc);
    categoryIdOf.set(family, doc._id);
  }

  // ── 3. Rapprochement avec le catalogue ────────────────────────────────────
  const composants = await db.collection('composants').find({}).toArray();
  const liveByKey = new Map();
  const deletedKeys = new Set();
  let maxCmpIndex = -1;
  for (const c of composants) {
    const m = /^Cmp(\d+)$/.exec(String(c._id));
    if (m) maxCmpIndex = Math.max(maxCmpIndex, Number(m[1]));
    if (c.name == null) continue;
    const k = matchKey(c.name);
    if (c.isDeleted === true) {
      deletedKeys.add(k);
      continue;
    }
    if (!liveByKey.has(k)) liveByKey.set(k, []);
    liveByKey.get(k).push(c);
  }

  const updates = [];
  const unchanged = [];
  const inserts = [];
  const ambiguous = [];
  const deletedOnly = [];
  for (const p of parts) {
    const categoryId = categoryIdOf.get(p.family);
    const emplacement = p.emplacements.length ? p.emplacements.join(' / ') : null;
    const live = liveByKey.get(p.key) ?? [];
    if (live.length > 1) {
      ambiguous.push(`${p.code} ${p.name} → ${live.map((c) => c._id).join(', ')}`);
      continue;
    }
    if (live.length === 1) {
      const cur = live[0];
      const want = {
        category_composant_id: categoryId,
        quantity_stocked: p.qty,
        code_article: p.code,
        emplacement,
        stock_min: p.stockMin,
      };
      if (isBlankStr(cur.status_composant)) want.status_composant = 'En stock';
      const set = {};
      for (const [field, value] of Object.entries(want)) {
        if (value == null) continue; // jamais d'effacement
        if (cur[field] !== value) set[field] = value;
      }
      if (Object.keys(set).length === 0) {
        unchanged.push(cur._id);
        continue;
      }
      const diff = Object.keys(set)
        .map((f) => `${f}: ${JSON.stringify(cur[f] ?? null)} → ${JSON.stringify(set[f])}`)
        .join(' · ');
      updates.push({ _id: cur._id, name: cur.name, set, diff });
      continue;
    }
    if (deletedKeys.has(p.key)) {
      deletedOnly.push(`${p.code} ${p.name}`);
      continue;
    }
    const doc = {
      _id: `Cmp${maxCmpIndex + 1 + inserts.length}`,
      name: p.name,
      category_composant_id: categoryId,
      quantity_stocked: p.qty,
      status_composant: 'En stock',
      code_article: p.code,
      isDeleted: false,
      createdAt: new Date(now + inserts.length),
      updatedAt: new Date(now + inserts.length),
      __v: 0,
    };
    if (emplacement) doc.emplacement = emplacement;
    if (p.stockMin != null) doc.stock_min = p.stockMin;
    inserts.push(doc);
  }

  // ── 4. Rapport ────────────────────────────────────────────────────────────
  console.log(`\nCatégories à créer : ${categoriesToCreate.length}`);
  categoriesToCreate.forEach((c) => console.log(`  + ${c._id} « ${c.category_composant} »`));
  console.log('Répartition par famille :');
  for (const family of familyOrder) {
    const n = parts.filter((p) => p.family === family).length;
    if (n) console.log(`  ${String(n).padStart(4)}  ${family} (${categoryIdOf.get(family)})`);
  }

  console.log(`\nMises à jour : ${updates.length} · inchangés : ${unchanged.length}`);
  updates.forEach((u) => console.log(`  ~ ${u._id} « ${u.name} » : ${u.diff}`));

  console.log(`\nInsertions : ${inserts.length}${inserts.length ? ` (${inserts[0]._id} … ${inserts[inserts.length - 1]._id})` : ''}`);
  inserts.slice(0, 5).forEach((d) => console.log(`  + ${d._id} « ${d.name} » ${d.code_article} qty=${d.quantity_stocked} cat=${d.category_composant_id}`));
  if (inserts.length > 5) console.log(`  … ${inserts.length - 5} autres`);

  console.log(`\nRéférences fusionnées : ${merged.length}`);
  merged.forEach((p) =>
    console.log(`  = « ${p.name} » ← ${p.members.map((m) => `${m.code}(${m.qty}@${m.emplacement ?? '?'})`).join(' + ')} → qty ${p.qty}`),
  );
  const warn = (title, list) => {
    console.log(`\n${title} : ${list.length}`);
    list.forEach((l) => console.log(`  !! ${l}`));
  };
  warn(`Désignations non reconnues (→ ${FALLBACK_FAMILY})`, unmapped);
  warn('Familles divergentes dans une fusion (1ʳᵉ ligne retenue)', familyConflicts.map((p) => `${p.name} : ${p.members.map((m) => `${m.code}=${m.family}`).join(', ')}`));
  warn('Stocks négatifs ramenés à 0', negative);
  warn('Plusieurs composants vivants pour une même référence (ignorés)', ambiguous);
  warn('Référence correspondant uniquement à un composant SUPPRIMÉ (ignorée)', deletedOnly);

  if (!APPLY) {
    console.log('\nDRY RUN : rien écrit. Relancer avec --apply pour appliquer.');
  } else {
    // ── 5. Écritures (ordre : catégories → mises à jour → insertions) ───────
    if (categoriesToCreate.length) {
      await db.collection('composant_categories').insertMany(categoriesToCreate, { ordered: true });
    }
    if (updates.length) {
      await db.collection('composants').bulkWrite(
        updates.map((u) => ({
          updateOne: {
            filter: { _id: u._id, isDeleted: { $ne: true } },
            update: { $set: { ...u.set, updatedAt: new Date() } },
          },
        })),
        { ordered: true },
      );
    }
    if (inserts.length) {
      await db.collection('composants').insertMany(inserts, { ordered: true });
    }

    // ── 6. Contrôles post-écriture ─────────────────────────────────────────
    const liveCount = await db.collection('composants').countDocuments({ isDeleted: { $ne: true } });
    const withCode = await db.collection('composants').countDocuments({ code_article: { $exists: true } });
    const liveCatIds = await db.collection('composant_categories').distinct('_id', { isDeleted: { $ne: true } });
    const orphans = await db
      .collection('composants')
      .countDocuments({ isDeleted: { $ne: true }, code_article: { $exists: true }, category_composant_id: { $nin: liveCatIds } });
    console.log(
      `\nAPPLIQUÉ : ${categoriesToCreate.length} catégories, ${updates.length} mises à jour, ${inserts.length} insertions.`,
    );
    console.log(`Contrôle : ${liveCount} composants vivants · ${withCode} avec code_article · ${orphans} importés à catégorie orpheline.`);
  }
} finally {
  await client.close();
}

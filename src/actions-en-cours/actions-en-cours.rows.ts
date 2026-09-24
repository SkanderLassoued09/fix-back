/**
 * « ACTIONS EN COURS » — construction PURE d'une ligne (aucune I/O), pour
 * être testée seule. Reproduit le fichier Excel tenu à la main jusqu'ici :
 * mêmes 12 colonnes, même code couleur :
 *   - vert   = étape faite (document présent, OK, ANNULER, IRREPARABLE) ;
 *   - orange = attendu mais manquant (DI encore ouverte) ;
 *   - rouge  = problème (RETOUR) ;
 *   - aucun  = sans objet (« SANS » sur une DI close sans ce document).
 */

export type DocType = 'Devis' | 'BC' | 'BL' | 'Facture';
export const DOC_TYPES: DocType[] = ['Devis', 'BC', 'BL', 'Facture'];

export type CellFill = 'green' | 'orange' | 'red' | null;

export interface CellLink {
  text: string;
  url: string;
}

export interface ActionsCell {
  value: string | Date | null;
  fill: CellFill;
  /** Liens cliquables DANS la cellule (un par cycle pour les documents). */
  links?: CellLink[];
}

export const ACTIONS_HEADERS = [
  'N° DI',
  'Désignation ',
  'N° Série',
  'Client ',
  'Date de réception',
  'Rangement ',
  'Devis',
  'BC',
  'BL',
  'Validation client',
  'Facture ',
  'Note',
];

/** Ligne de cycle (`logsdis`) réduite à ce que l'export lit. */
export interface CycleInput {
  idIgnore: number;
  driveDocs?: Record<string, any> | null;
  docNumeros?: Partial<Record<DocType, string>> | null;
  devis?: string | null;
  bon_de_commande?: string | null;
  bon_de_livraison?: string | null;
  facture?: string | null;
}

/** DI + ses cycles + noms résolus — tout ce qu'il faut pour une ligne. */
export interface ActionsRowInput {
  _idnum: string;
  title?: string | null;
  nSerie?: string | number | null;
  clientName: string;
  locationName: string;
  dateReception?: Date | null;
  createdAt?: Date | null;
  status: string;
  ignoreCount?: number | null;
  statusHistory?: Array<{ status: string; at: Date }> | null;
  statusUpdatedAt?: Date | null;
  retourDate?: Date | null;
  annulationParClient?: boolean | null;
  driveDocs?: Record<string, any> | null;
  docNumeros?: Partial<Record<DocType, string>> | null;
  devis?: string | null;
  bon_de_commande?: string | null;
  bon_de_livraison?: string | null;
  facture?: string | null;
  cycles: CycleInput[];
  /** Nom (username) du tech diag / répa du cycle COURANT. */
  techDiag?: string | null;
  techRep?: string | null;
}

const CLOSED = new Set(['FINISHED', 'IRREPARABLE', 'ANNULER']);

const NOTE_BY_STATUS: Record<string, string> = {
  CREATED: 'ATT DIAGNOSTIC',
  PENDING1: 'ATT DIAGNOSTIC',
  MagasinEstimation: 'ATT PDR',
  CONFIRMATION: 'ATT PDR',
  PROCESSING: 'ATT PDR',
  INMAGASIN: 'ATT PDR',
  ATTENTE_CONFIRMATION_COORDINATION: 'ATT PDR',
  MAGASIN_FINALISATION: 'ATT PDR',
  PENDING2: 'ATT PRIX',
  PRICING_DIAG: 'ATT PRIX',
  PRICING: 'ATT PRIX',
  WAITING_DEVIS: 'ATT DEVIS',
  NEGOTIATION1: 'ATT DEVIS',
  WAITING_BC: 'ATT BC',
  NEGOTIATION2: 'ATT BC',
  ATTENTE_BC_DEVIS: 'ATT BC',
  CONFIRMATION_COMPOSANTS: 'ATT PDR',
  PENDING3: 'ATT REPARATION',
  WAITING_BL: 'ATT BL',
  WAITING_FACTURE: 'ATT FACTURE',
  FINISHED: 'OK',
  IRREPARABLE: 'IRREPARABLE',
  ANNULER: 'ANNULER',
};

const DIAG_STATUSES = ['DIAGNOSTIC', 'DIAGNOSTIC_Pause', 'INDIAGNOSTIC'];
const REP_STATUSES = ['REPARATION', 'REPARATION_Pause', 'INREPARATION'];

const TZ = () => process.env.APP_TIMEZONE || 'Africa/Tunis';

/** Jour civil à Tunis, en `dd/MM/yyyy`. */
export function formatDayTunis(d: Date | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ(),
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/**
 * Date « civile » pour une cellule Excel : minuit UTC du JOUR vu à Tunis.
 * Sans ça, une réception à 00:30 heure de Tunis (23:30 UTC la veille)
 * s'afficherait la veille dans Excel.
 */
export function toExcelDay(d: Date | null | undefined): Date | null {
  const s = formatDayTunis(d);
  if (!s) return null;
  const [dd, mm, yyyy] = s.split('/').map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

/** Tri numérique des refs « T963 » < « T1000 » ; refs non T en fin. */
export function compareIdnum(a: string, b: string): number {
  const na = /^T(\d+)$/i.exec(a ?? '');
  const nb = /^T(\d+)$/i.exec(b ?? '');
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  if (na) return -1;
  if (nb) return 1;
  return String(a ?? '').localeCompare(String(b ?? ''), 'fr', {
    numeric: true,
  });
}

function hasDriveRef(doc: any): boolean {
  return !!doc && typeof doc === 'object' && !!doc.driveFileId;
}

const SCALAR: Record<DocType, keyof CycleInput> = {
  Devis: 'devis',
  BC: 'bon_de_commande',
  BL: 'bon_de_livraison',
  Facture: 'facture',
};

/**
 * Nom Drive standard réduit au jour : `AKWEL_Devis_09-10-2026_14-32-05.pdf`
 * → `AKWEL_Devis_09-10-2026`. Un nom hors standard est rendu tel quel.
 */
export function shortDocName(name: string): string {
  const n = (name ?? '').trim();
  const m = /^(.+_\d{2}-\d{2}-\d{4})_\d{2}-\d{2}-\d{2}(\.\w+)?$/.exec(n);
  return m ? m[1] : n;
}

/**
 * Entrées d'un document sur TOUS les cycles (cycle 0 → courant), une par
 * cycle. Par cycle : nom Drive standard (lié au PDF) › N° repris de l'ancien
 * Excel (`docNumeros`, historique) › « REÇU » si seul un lien existe. Le miroir
 * DI sert de repli au cycle COURANT uniquement (il ne porte que lui).
 */
export function docEntries(
  input: ActionsRowInput,
  type: DocType,
): Array<{ text: string; url: string | null }> {
  const current = input.ignoreCount ?? 0;
  const byCycle = new Map<number, CycleInput>();
  for (const c of input.cycles ?? []) byCycle.set(c.idIgnore, c);
  const out: Array<{ text: string; url: string | null }> = [];
  for (let i = 0; i <= current; i++) {
    const cyc = byCycle.get(i);
    const isCurrent = i === current;
    let ref = cyc?.driveDocs?.[type];
    if (!hasDriveRef(ref) && isCurrent) ref = input.driveDocs?.[type];
    const scalar =
      (cyc?.[SCALAR[type]] as string) ||
      (isCurrent ? (input[SCALAR[type]] as string) : '') ||
      '';
    const url = (hasDriveRef(ref) ? ref.webViewLink : '') || scalar || null;
    const numero =
      cyc?.docNumeros?.[type] || (isCurrent ? input.docNumeros?.[type] : '');

    let text = '';
    if (hasDriveRef(ref) && ref.name) text = shortDocName(ref.name);
    else if (numero) text = String(numero).trim();
    else if (url) text = 'REÇU';
    if (!text) continue;
    if (!out.some((e) => e.text === text && e.url === url)) {
      out.push({ text, url });
    }
  }
  return out;
}

function docCell(input: ActionsRowInput, type: DocType): ActionsCell {
  const entries = docEntries(input, type);
  if (entries.length) {
    const links = entries
      .filter((e) => !!e.url)
      .map((e) => ({ text: e.text, url: e.url as string }));
    return {
      value: entries.map((e) => e.text).join('\n'),
      fill: 'green',
      ...(links.length ? { links } : {}),
    };
  }
  if (input.status === 'IRREPARABLE' || input.status === 'ANNULER') {
    return { value: input.status, fill: 'green' };
  }
  if (input.status === 'FINISHED') return { value: 'SANS', fill: null };
  return { value: null, fill: 'orange' };
}

function lastEnteredAt(
  input: ActionsRowInput,
  statuses: string[],
): Date | null {
  const hist = input.statusHistory ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (statuses.includes(hist[i]?.status)) return hist[i].at ?? null;
  }
  return input.statusUpdatedAt ?? null;
}

function techTag(name: string | null | undefined): string {
  return (name ?? '').trim().toUpperCase() || 'NC';
}

export function deriveNote(input: ActionsRowInput): string {
  const s = input.status;
  if (DIAG_STATUSES.includes(s)) {
    const at = formatDayTunis(lastEnteredAt(input, ['DIAGNOSTIC']));
    return ['DIAG', techTag(input.techDiag), at].filter(Boolean).join('_');
  }
  if (REP_STATUSES.includes(s)) {
    const at = formatDayTunis(lastEnteredAt(input, ['REPARATION']));
    return ['REP', techTag(input.techRep), at].filter(Boolean).join('_');
  }
  if (/^RETOUR\d*$/.test(s)) {
    return ['RETOUR', formatDayTunis(input.retourDate)].filter(Boolean).join(' ');
  }
  return NOTE_BY_STATUS[s] ?? s ?? '';
}

function hasBC(input: ActionsRowInput): boolean {
  return docEntries(input, 'BC').length > 0;
}

export function deriveValidation(input: ActionsRowInput): ActionsCell {
  const s = input.status;
  if (s === 'ANNULER' || input.annulationParClient) {
    return { value: 'ANNULER', fill: 'green' };
  }
  if (s === 'IRREPARABLE') return { value: 'IRREPARABLE', fill: 'green' };
  const retours = input.ignoreCount ?? 0;
  if (retours >= 1) {
    return { value: retours === 1 ? 'RETOUR' : `RETOUR ${retours}`, fill: 'red' };
  }
  if (hasBC(input) || s === 'FINISHED') return { value: 'OK', fill: 'green' };
  return { value: null, fill: 'orange' };
}

function noteCell(input: ActionsRowInput): ActionsCell {
  const value = deriveNote(input);
  const fill: CellFill = CLOSED.has(input.status) ? 'green' : 'orange';
  return { value: value || null, fill };
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Une ligne complète, dans l'ordre de `ACTIONS_HEADERS`. */
export function buildActionsRow(input: ActionsRowInput): ActionsCell[] {
  const location = text(input.locationName);
  return [
    { value: text(input._idnum), fill: 'green' },
    { value: text(input.title), fill: 'green' },
    { value: text(input.nSerie), fill: 'green' },
    { value: text(input.clientName), fill: 'green' },
    {
      value: toExcelDay(input.dateReception ?? input.createdAt ?? null),
      fill: 'green',
    },
    { value: location, fill: location ? 'green' : 'orange' },
    docCell(input, 'Devis'),
    docCell(input, 'BC'),
    docCell(input, 'BL'),
    deriveValidation(input),
    docCell(input, 'Facture'),
    noteCell(input),
  ];
}

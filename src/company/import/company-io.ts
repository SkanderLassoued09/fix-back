/**
 * SCHÉMA CANONIQUE des colonnes société — SOURCE DE VÉRITÉ UNIQUE partagée par
 * l'export ET l'import. L'ordre du tableau = l'ordre des colonnes du .xlsx, et
 * les mêmes en-têtes servent de modèle d'import (round-trip : exporter → éditer
 * dans Excel → réimporter le MÊME fichier sans duplication).
 *
 * Chaque colonne mappe un en-tête ↔ un chemin dans le document Company. Les
 * contacts par service sont EMBEDDED ({name,email,phone}) et la région est un
 * simple texte → aucune résolution nom→id : on lit/écrit la valeur telle quelle.
 */
export type CompanyColKind = 'text' | 'email' | 'phone' | 'exon';

export interface CompanyColumn {
  header: string; // en-tête EXACT du .xlsx (export l'écrit, import le matche)
  path: string[]; // chemin dans le doc, ex. ['raisonSociale'] | ['serviceAchat','name']
  kind?: CompanyColKind;
  required?: boolean;
}

export const COMPANY_COLUMNS: CompanyColumn[] = [
  { header: 'Nom', path: ['name'] },
  { header: 'Raison sociale', path: ['raisonSociale'], required: true },
  { header: 'Région', path: ['region'] },
  { header: 'Adresse', path: ['address'] },
  { header: 'E-mail', path: ['email'], kind: 'email' },
  { header: 'Téléphone', path: ['phone'], kind: 'phone' },
  { header: 'Fax', path: ['fax'], kind: 'phone' },
  { header: 'Website', path: ['webSiteLink'] },
  { header: 'Matricule fiscale', path: ['mf'] },
  { header: 'RNE', path: ['rne'] },
  { header: 'Exonération', path: ['Exoneration'], kind: 'exon' },
  { header: 'Activité principale', path: ['activitePrincipale'] },
  { header: 'Activité secondaire', path: ['activiteSecondaire'] },
  { header: 'Contact Achat Nom', path: ['serviceAchat', 'name'] },
  { header: 'Contact Achat E-mail', path: ['serviceAchat', 'email'], kind: 'email' },
  { header: 'Contact Achat Téléphone', path: ['serviceAchat', 'phone'], kind: 'phone' },
  { header: 'Contact Technique Nom', path: ['serviceTechnique', 'name'] },
  { header: 'Contact Technique E-mail', path: ['serviceTechnique', 'email'], kind: 'email' },
  { header: 'Contact Technique Téléphone', path: ['serviceTechnique', 'phone'], kind: 'phone' },
  { header: 'Contact Financier Nom', path: ['serviceFinancier', 'name'] },
  { header: 'Contact Financier E-mail', path: ['serviceFinancier', 'email'], kind: 'email' },
  { header: 'Contact Financier Téléphone', path: ['serviceFinancier', 'phone'], kind: 'phone' },
];

/** En-têtes exacts, dans l'ordre — l'export et le modèle d'import les utilisent. */
export const EXPORT_HEADERS: string[] = COMPANY_COLUMNS.map((c) => c.header);

// ── Primitives partagées ────────────────────────────────────────────────────

/** Normalise un en-tête pour un match tolérant (accents, casse, ponctuation). */
export function normHeader(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Valeur d'affichage propre : null/undefined et les chaînes legacy
 *  "undefined"/"null" deviennent '' (jamais écrites dans l'export). */
export function cleanCell(v: unknown): string {
  if (v == null) return '';
  const s = v instanceof Date ? (isNaN(v.getTime()) ? '' : v.toISOString()) : String(v);
  const t = s.trim().toLowerCase();
  return t === '' || t === 'undefined' || t === 'null' ? '' : s.trim();
}

function getPath(obj: any, path: string[]): any {
  return path.reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** Company (doc) → ligne de cellules, dans l'ordre canonique. */
export function companyToRow(company: any): string[] {
  return COMPANY_COLUMNS.map((c) => cleanCell(getPath(company, c.path)));
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PHONE_RE = /^[+0-9 ()\-.]{6,20}$/;

import { withErrorContext } from '../common/error-context';
/**
 * Valeurs INITIALES d'un Composant du catalogue (décision du 2026-09-15) : aucun
 * champ n'est laissé `null`, absent, ni porteur d'une sentinelle écrite par une
 * interpolation front non gardée (« undefined », « null », « Invalid Date »).
 *   - texte  → `''`
 *   - nombre → `0` ; pour les prix, `0` signifie « pas de prix » (jamais gratuit)
 *
 * Source unique : `createComposant` l'applique, la migration
 * `017-composant-field-defaults.mjs` en recopie les listes pour l'existant.
 */
export const COMPOSANT_TEXT_FIELDS = [
  'package',
  'category_composant_id',
  'coming_date',
  'link',
  'pdf',
  'status_composant',
  'code_article',
  'emplacement',
] as const;

export const COMPOSANT_NUMBER_FIELDS = [
  'prix_achat',
  'prix_vente',
  'quantity_stocked',
  'stock_min',
] as const;

const SENTINELS = new Set(['undefined', 'null', 'NaN', 'Invalid Date']);

/** Texte : valeur réelle conservée telle quelle, vide/sentinelle → `''`. */
export function textOrDefault(value: unknown): string {
  try {
    if (value === null || value === undefined) return '';
    const s = typeof value === 'string' ? value : String(value);
    return SENTINELS.has(s.trim()) ? '' : s;
  } catch (error) {
    throw withErrorContext(error, 'textOrDefault');
  }
}

/** Nombre : fini conservé (une chaîne numérique est convertie), sinon `0`. */
export function numberOrDefault(value: unknown): number {
  try {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  } catch (error) {
    throw withErrorContext(error, 'numberOrDefault');
  }
}

/** Copie de `input` dont chaque champ du catalogue est initialisé. */
export function withComposantDefaults<T extends object>(input: T): T {
  try {
    const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    for (const field of COMPOSANT_TEXT_FIELDS) out[field] = textOrDefault(out[field]);
    for (const field of COMPOSANT_NUMBER_FIELDS) out[field] = numberOrDefault(out[field]);
    if (typeof out.isDeleted !== 'boolean') out.isDeleted = false;
    return out as T;
  } catch (error) {
    throw withErrorContext(error, 'withComposantDefaults');
  }
}

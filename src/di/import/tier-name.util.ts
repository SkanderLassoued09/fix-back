/**
 * Normalisation d'un nom de tiers (Client ou Société) — clé de rapprochement
 * PARTAGÉE entre l'import (`matchTier`) et les alias (`tier_aliases`), pour que
 * la même chaîne produise EXACTEMENT la même clé des deux côtés.
 *
 * Minuscules, accents retirés, tout caractère non alphanumérique → espace,
 * espaces multiples réduits, trim. Ex. « PERSO (PROMODAR) » → « perso promodar ».
 */
export function normalizeTierName(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Décision d'ambiguïté « both » (Client ET Société) tranchée par l'utilisateur :
 * le tiers est rattaché AU CLIENT ou À LA SOCIÉTÉ, jamais rien d'autre.
 */
export type DecisionKind = 'client' | 'company';

/**
 * WHITELIST STRICTE du champ `kind` d'une décision. Le backend ne doit JAMAIS
 * accepter une valeur arbitraire au seul motif qu'elle est « truthy » : un
 * payload multipart forgé (ou un futur autre client) pourrait sinon faire
 * créer une DI SANS rattachement de tiers. Seules `'client'` et `'company'`
 * sont valides ; tout le reste (`'foo'`, `'companyxxx'`, `'true'`, `'1'`,
 * `{}`, `null`, `undefined`, …) est rejeté.
 */
export function isValidDecisionKind(v: unknown): v is DecisionKind {
  return v === 'client' || v === 'company';
}

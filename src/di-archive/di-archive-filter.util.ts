import { FilterQuery } from 'mongoose';
import { DiArchiveDocType, StatutCompletude } from './entities/di-archive.entity';

/**
 * Single source of truth for « document manquant » on a DiArchive — the SAME
 * registry-side rule the daily digest uses (see [[di-archive-digest.service]]).
 *
 * A document TEXT ref is MISSING when the registry value is one of the "empty"
 * sentinels: null / undefined / empty / whitespace-only / `_` / `Sans` (any
 * case). Anything else — a real reference, a business marker (`ANNULER`,
 * `IRREPARABLE`), a payment mode, a phone… — is PRESENT. The paired Drive
 * upload (`bc`/`bl`/…) is intentionally IGNORED here: the filter reports the
 * registry gap, exactly like the digest management already receives.
 */
export function isDocMissing(value: unknown): boolean {
  if (value == null) return true;
  const s = String(value).trim();
  if (s === '') return true;
  if (s === '_') return true;
  if (/^sans$/i.test(s)) return true;
  return false;
}

/**
 * Mongo-side equivalent of `isDocMissing` for a string ref column. A value is
 * missing when it is null/absent OR (after trim) empty / `_` / `sans`. This
 * regex is proven equivalent to `isDocMissing` for every non-null string by the
 * unit tests — keep the two in lockstep.
 */
export const MISSING_REF_REGEX = /^\s*(?:_|sans)?\s*$/i;

/** docType → the DiArchive text-ref field the completeness rule reads. */
export const REF_FIELD_BY_DOCTYPE: Record<DiArchiveDocType, string> = {
  [DiArchiveDocType.BC]: 'bcRef',
  [DiArchiveDocType.BL]: 'blRef',
  [DiArchiveDocType.DEVIS]: 'devisRef',
  [DiArchiveDocType.FACTURE]: 'factureRef',
};

/** Mongo predicate matching rows whose `refField` is MISSING (≡ isDocMissing). */
export function missingRefFilter(refField: string): FilterQuery<any> {
  return {
    $or: [
      { [refField]: { $in: [null] } }, // null OR field absent
      { [refField]: { $regex: MISSING_REF_REGEX } }, // '', whitespace, _, sans
    ],
  };
}

/** Escape a user string so it is matched LITERALLY inside a `$regex` (contains). */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shape accepted by `buildArchiveFilter` (mirrors the GraphQL input). */
export interface ArchiveFilterInput {
  missingDocs?: DiArchiveDocType[] | null;
  refOrigine?: string | null;
  title?: string | null;
  numSerie?: string | null;
  client?: string | null; // matches clientNom OR societeNom
  arrangement?: string | null;
  validClient?: string | null;
  statutCompletude?: StatutCompletude[] | null;
  statutHistorique?: string[] | null;
}

/** Case-insensitive "contains" predicate for a free-text column. */
function containsFilter(field: string, value: string): FilterQuery<any> {
  return { [field]: { $regex: escapeRegex(value.trim()), $options: 'i' } };
}

/**
 * Build the Mongo query from the filter input. All criteria are CUMULATIVE
 * (combined with `$and`), so « manque Facture » + « statut = Terminé » returns
 * their INTERSECTION. Multi-selected missing docs are ALSO an AND (« manque
 * Facture ET BL » → rows missing both). An empty/undefined input → `{}` (all).
 */
export function buildArchiveFilter(input?: ArchiveFilterInput | null): FilterQuery<any> {
  const and: FilterQuery<any>[] = [];
  if (!input) return {};

  // Missing documents (AND) — each selected doc adds a missing-ref predicate.
  for (const docType of input.missingDocs ?? []) {
    const refField = REF_FIELD_BY_DOCTYPE[docType];
    if (refField) and.push(missingRefFilter(refField));
  }

  // Free-text column filters (case-insensitive contains).
  if (input.refOrigine?.trim()) and.push(containsFilter('refOrigine', input.refOrigine));
  if (input.title?.trim()) and.push(containsFilter('title', input.title));
  if (input.numSerie?.trim()) and.push(containsFilter('numSerie', input.numSerie));
  if (input.arrangement?.trim()) and.push(containsFilter('arrangement', input.arrangement));
  if (input.validClient?.trim()) and.push(containsFilter('validClient', input.validClient));
  // Client / Société is one column in the UI → match either underlying field.
  if (input.client?.trim()) {
    const rx = { $regex: escapeRegex(input.client.trim()), $options: 'i' };
    and.push({ $or: [{ clientNom: rx }, { societeNom: rx }] });
  }

  // Enumerated columns (multi-select → $in).
  if (input.statutCompletude?.length) {
    and.push({ statutCompletude: { $in: input.statutCompletude } });
  }
  if (input.statutHistorique?.length) {
    and.push({ statutHistorique: { $in: input.statutHistorique } });
  }

  return and.length ? { $and: and } : {};
}

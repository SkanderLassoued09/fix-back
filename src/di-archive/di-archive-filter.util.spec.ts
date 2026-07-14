import {
  buildArchiveFilter,
  escapeRegex,
  isDocMissing,
  missingRefFilter,
  MISSING_REF_REGEX,
} from './di-archive-filter.util';
import {
  DiArchiveDocType,
  StatutCompletude,
} from './entities/di-archive.entity';

/**
 * The registry-side « manquant » rule + the Mongo query builder that powers the
 * `/archives` filters. The critical guarantee is that the Mongo predicate is
 * EQUIVALENT to `isDocMissing` — proven here over a representative battery.
 */
describe('di-archive-filter.util', () => {
  // Representative registry values: sentinels (missing) vs real content (present).
  const SAMPLES: Array<[unknown, boolean]> = [
    [null, true],
    [undefined, true],
    ['', true],
    ['   ', true],
    ['_', true],
    [' _ ', true],
    ['sans', true],
    ['SANS', true],
    ['Sans', true],
    ['  sans  ', true],
    ['__', false],
    ['sans supplément', false],
    ['ANNULER', false],
    ['IRREPARABLE', false],
    ['072/24', false],
    ['F-2024-11', false],
    ['6200', false],
    ['OK', false],
  ];

  describe('isDocMissing', () => {
    it.each(SAMPLES)('isDocMissing(%p) === %p', (value, expected) => {
      expect(isDocMissing(value)).toBe(expected);
    });
  });

  describe('MISSING_REF_REGEX ≡ isDocMissing (Mongo predicate equivalence)', () => {
    // The Mongo missing predicate is: field is null/absent OR regex matches the
    // raw string. This JS mirror must agree with isDocMissing for every sample.
    const mongoSaysMissing = (v: unknown): boolean =>
      v == null ? true : MISSING_REF_REGEX.test(String(v));

    it.each(SAMPLES)('regex agrees with the rule for %p', (value) => {
      expect(mongoSaysMissing(value)).toBe(isDocMissing(value));
    });
  });

  describe('missingRefFilter', () => {
    it('matches null/absent OR the empty-sentinel regex on the given field', () => {
      expect(missingRefFilter('factureRef')).toEqual({
        $or: [
          { factureRef: { $in: [null] } },
          { factureRef: { $regex: MISSING_REF_REGEX } },
        ],
      });
    });
  });

  describe('escapeRegex', () => {
    it('escapes regex metacharacters so text is matched literally', () => {
      expect(escapeRegex('a.b+c(d)')).toBe('a\\.b\\+c\\(d\\)');
    });
  });

  describe('buildArchiveFilter', () => {
    it('returns {} for an empty/undefined filter (all rows)', () => {
      expect(buildArchiveFilter()).toEqual({});
      expect(buildArchiveFilter({})).toEqual({});
    });

    it('« manque Facture » → ONLY the facture-missing predicate', () => {
      const q = buildArchiveFilter({ missingDocs: [DiArchiveDocType.FACTURE] });
      expect(q).toEqual({ $and: [missingRefFilter('factureRef')] });
    });

    it('« manque Facture ET BL » → BOTH predicates AND-ed (intersection)', () => {
      const q = buildArchiveFilter({
        missingDocs: [DiArchiveDocType.FACTURE, DiArchiveDocType.BL],
      });
      expect(q).toEqual({
        $and: [missingRefFilter('factureRef'), missingRefFilter('blRef')],
      });
    });

    it('KEY use case: « manque Facture » + statut = INTERSECTION (AND)', () => {
      const q: any = buildArchiveFilter({
        missingDocs: [DiArchiveDocType.FACTURE],
        statutHistorique: ['Livré', 'Terminé'],
      });
      expect(q.$and).toHaveLength(2);
      expect(q.$and).toContainEqual(missingRefFilter('factureRef'));
      expect(q.$and).toContainEqual({
        statutHistorique: { $in: ['Livré', 'Terminé'] },
      });
    });

    it('text filters → case-insensitive escaped "contains"', () => {
      const q: any = buildArchiveFilter({ title: 'carte four' });
      expect(q.$and[0]).toEqual({
        title: { $regex: 'carte four', $options: 'i' },
      });
    });

    it('client filter matches clientNom OR societeNom', () => {
      const q: any = buildArchiveFilter({ client: 'cogemhy' });
      expect(q.$and[0]).toEqual({
        $or: [
          { clientNom: { $regex: 'cogemhy', $options: 'i' } },
          { societeNom: { $regex: 'cogemhy', $options: 'i' } },
        ],
      });
    });

    it('statutCompletude multi-select → $in', () => {
      const q: any = buildArchiveFilter({
        statutCompletude: [StatutCompletude.INCOMPLET, StatutCompletude.COMPLET],
      });
      expect(q.$and[0]).toEqual({
        statutCompletude: { $in: ['INCOMPLET', 'COMPLET'] },
      });
    });

    it('ignores blank text filters (whitespace only)', () => {
      expect(buildArchiveFilter({ title: '   ', numSerie: '' })).toEqual({});
    });
  });
});

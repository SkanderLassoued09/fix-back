import {
  COMPOSANT_NUMBER_FIELDS,
  COMPOSANT_TEXT_FIELDS,
  numberOrDefault,
  textOrDefault,
  withComposantDefaults,
} from './composant-defaults';

describe('composant-defaults', () => {
  it('initialise TOUS les champs d’un composant réduit à son nom', () => {
    const out: any = withComposantDefaults({ name: 'LM317' });

    for (const f of COMPOSANT_TEXT_FIELDS) expect(out[f]).toBe('');
    for (const f of COMPOSANT_NUMBER_FIELDS) expect(out[f]).toBe(0);
    expect(out.isDeleted).toBe(false);
    expect(out.name).toBe('LM317');
  });

  it('remplace null, undefined et les sentinelles héritées', () => {
    expect(textOrDefault(null)).toBe('');
    expect(textOrDefault(undefined)).toBe('');
    for (const s of ['undefined', 'null', 'NaN', 'Invalid Date', ' null ']) {
      expect(textOrDefault(s)).toBe('');
    }
    expect(numberOrDefault(null)).toBe(0);
    expect(numberOrDefault(undefined)).toBe(0);
    expect(numberOrDefault(NaN)).toBe(0);
    expect(numberOrDefault('')).toBe(0);
    expect(numberOrDefault('abc')).toBe(0);
  });

  it('conserve les valeurs réelles, dates héritées et zéros compris', () => {
    const legacyDate = 'Fri Jan 23 2026 00:00:00 GMT+0100 (heure normale d’Europe centrale)';
    const out: any = withComposantDefaults({
      name: 'X',
      package: 'TO-220',
      coming_date: legacyDate,
      prix_vente: 12.5,
      quantity_stocked: 0,
      stock_min: '3',
      isDeleted: true,
    });
    expect(out.package).toBe('TO-220');
    expect(out.coming_date).toBe(legacyDate);
    expect(out.prix_vente).toBe(12.5);
    expect(out.quantity_stocked).toBe(0);
    expect(out.stock_min).toBe(3);
    expect(out.isDeleted).toBe(true);
  });

  it('ne modifie pas l’objet reçu', () => {
    const input: any = { name: 'Y', pdf: null };
    withComposantDefaults(input);
    expect(input.pdf).toBeNull();
  });
});

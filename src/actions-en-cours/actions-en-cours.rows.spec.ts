import {
  ActionsRowInput,
  buildActionsRow,
  compareIdnum,
  deriveNote,
  deriveValidation,
  shortDocName,
  toExcelDay,
} from './actions-en-cours.rows';

const REF = (id: string, name = `AKWEL_${id}_09-10-2026_14-32-05.pdf`) => ({
  driveFileId: id,
  webViewLink: `https://drive/${id}`,
  name,
});

function di(over: Partial<ActionsRowInput> = {}): ActionsRowInput {
  return {
    _idnum: 'T1299',
    title: 'ALIMENTATION',
    nSerie: '10425000028',
    clientName: 'AKWEL',
    locationName: 'A51',
    dateReception: new Date('2026-03-10T09:00:00Z'),
    status: 'FINISHED',
    ignoreCount: 0,
    cycles: [],
    ...over,
  };
}

const COL = { devis: 6, bc: 7, bl: 8, validation: 9, facture: 10, note: 11 };

describe('ACTIONS EN COURS — ligne', () => {
  it('DI terminée : nom Drive (au jour) des 4 documents, lié, en vert', () => {
    const row = buildActionsRow(
      di({
        cycles: [
          {
            idIgnore: 0,
            driveDocs: {
              Devis: REF('Devis'),
              BC: REF('BC'),
              BL: REF('BL'),
              Facture: REF('Facture'),
            },
            // Historique Excel : ignoré dès qu'un nom Drive existe.
            docNumeros: { Devis: '046/26' },
          },
        ],
      }),
    );
    expect(row.map((c) => c.value)).toEqual([
      'T1299',
      'ALIMENTATION',
      '10425000028',
      'AKWEL',
      new Date(Date.UTC(2026, 2, 10)),
      'A51',
      'AKWEL_Devis_09-10-2026',
      'AKWEL_BC_09-10-2026',
      'AKWEL_BL_09-10-2026',
      'OK',
      'AKWEL_Facture_09-10-2026',
      'OK',
    ]);
    expect(row.every((c) => c.fill === 'green')).toBe(true);
    expect(row[COL.devis].links).toEqual([
      { text: 'AKWEL_Devis_09-10-2026', url: 'https://drive/Devis' },
    ]);
  });

  it('retour : un nom Drive par cycle, une ligne chacun, tous liés', () => {
    const row = buildActionsRow(
      di({
        status: 'WAITING_FACTURE',
        ignoreCount: 1,
        cycles: [
          { idIgnore: 0, driveDocs: { BL: REF('b0', 'AKWEL_BL_02-03-2026_10-00-00.pdf') } },
          { idIgnore: 1, driveDocs: {} },
        ],
        // Cycle courant : le nom n'est que sur le miroir DI.
        driveDocs: { BL: REF('b1', 'AKWEL_BL_20-09-2026_09-15-00.pdf') },
      }),
    );
    expect(row[COL.bl].value).toBe('AKWEL_BL_02-03-2026\nAKWEL_BL_20-09-2026');
    expect(row[COL.bl].links?.map((l) => l.url)).toEqual([
      'https://drive/b0',
      'https://drive/b1',
    ]);
  });

  it('priorité : nom Drive › N° de l\'ancien Excel › « REÇU » (lien seul)', () => {
    const row = buildActionsRow(
      di({
        status: 'WAITING_FACTURE',
        driveDocs: { Devis: REF('d') },
        docNumeros: { Devis: '046/26', BC: 'CFR1736066' },
        bon_de_livraison: 'https://drive/legacy-bl',
      }),
    );
    expect(row[COL.devis].value).toBe('AKWEL_d_09-10-2026');
    expect(row[COL.bc]).toEqual({ value: 'CFR1736066', fill: 'green' });
    expect(row[COL.bl]).toEqual({
      value: 'REÇU',
      fill: 'green',
      links: [{ text: 'REÇU', url: 'https://drive/legacy-bl' }],
    });
  });

  it('retour : N° historiques de chaque cycle, une ligne chacun, validation RETOUR en rouge', () => {
    const row = buildActionsRow(
      di({
        status: 'WAITING_BL',
        ignoreCount: 1,
        cycles: [
          { idIgnore: 0, docNumeros: { BL: '207/24' } },
          { idIgnore: 1, docNumeros: {} },
        ],
        // Le miroir DI porte le cycle courant quand sa ligne n'a pas le numéro.
        docNumeros: { BL: '016/25' },
      }),
    );
    expect(row[COL.bl]).toEqual({ value: '207/24\n016/25', fill: 'green' });
    expect(row[COL.validation]).toEqual({ value: 'RETOUR', fill: 'red' });
    expect(row[COL.facture]).toEqual({ value: null, fill: 'orange' });
    expect(row[COL.note]).toEqual({ value: 'ATT BL', fill: 'orange' });
  });

  it('deuxième retour → « RETOUR 2 »', () => {
    expect(deriveValidation(di({ status: 'DIAGNOSTIC', ignoreCount: 2 }))).toEqual({
      value: 'RETOUR 2',
      fill: 'red',
    });
  });

  it('IRREPARABLE / ANNULER sans document : le mot du statut, en vert', () => {
    for (const status of ['IRREPARABLE', 'ANNULER']) {
      const row = buildActionsRow(di({ status }));
      expect(row[COL.devis]).toEqual({ value: status, fill: 'green' });
      expect(row[COL.validation]).toEqual({ value: status, fill: 'green' });
      expect(row[COL.note]).toEqual({ value: status, fill: 'green' });
    }
  });

  it('DI terminée sans un document : « SANS », sans couleur', () => {
    const row = buildActionsRow(di({ status: 'FINISHED' }));
    expect(row[COL.devis]).toEqual({ value: 'SANS', fill: null });
  });

  it('devis déposé, BC attendu : BC orange, validation vide', () => {
    const row = buildActionsRow(
      di({ status: 'WAITING_BC', driveDocs: { Devis: REF('x') } }),
    );
    expect(row[COL.devis].fill).toBe('green');
    expect(row[COL.bc]).toEqual({ value: null, fill: 'orange' });
    expect(row[COL.validation]).toEqual({ value: null, fill: 'orange' });
    expect(row[COL.note].value).toBe('ATT BC');
  });

  it('un numéro sans PDF (repris de l\'ancien Excel) s\'affiche quand même', () => {
    const row = buildActionsRow(
      di({ status: 'WAITING_BL', docNumeros: { BC: 'CFR1736066' } }),
    );
    expect(row[COL.bc]).toEqual({ value: 'CFR1736066', fill: 'green' });
    expect(row[COL.validation]).toEqual({ value: 'OK', fill: 'green' });
  });

  it('rangement manquant → orange', () => {
    expect(buildActionsRow(di({ locationName: '' }))[5]).toEqual({
      value: null,
      fill: 'orange',
    });
  });
});

describe('ACTIONS EN COURS — note', () => {
  it('diagnostic : DIAG_<TECH>_<jour d\'entrée en DIAGNOSTIC>', () => {
    expect(
      deriveNote(
        di({
          status: 'DIAGNOSTIC_Pause',
          techDiag: 'rachida',
          statusHistory: [
            { status: 'PENDING1', at: new Date('2026-01-20T08:00:00Z') },
            { status: 'DIAGNOSTIC', at: new Date('2026-01-24T08:00:00Z') },
            { status: 'DIAGNOSTIC_Pause', at: new Date('2026-01-25T08:00:00Z') },
          ],
        }),
      ),
    ).toBe('DIAG_RACHIDA_24/01/2026');
  });

  it('réparation : REP_<TECH>_<jour>', () => {
    expect(
      deriveNote(
        di({
          status: 'INREPARATION',
          techRep: 'Khalil',
          statusHistory: [
            { status: 'REPARATION', at: new Date('2026-02-04T10:00:00Z') },
          ],
        }),
      ),
    ).toBe('REP_KHALIL_04/02/2026');
  });

  it('attente magasin : ATT PDR', () => {
    expect(deriveNote(di({ status: 'MagasinEstimation' }))).toBe('ATT PDR');
  });

  it('retour ouvert : RETOUR <date du retour>', () => {
    expect(
      deriveNote(
        di({ status: 'RETOUR1', retourDate: new Date('2026-09-16T09:00:00Z') }),
      ),
    ).toBe('RETOUR 16/09/2026');
  });
});

describe('ACTIONS EN COURS — utilitaires', () => {
  it('nom Drive standard réduit au jour ; nom hors standard inchangé', () => {
    expect(shortDocName('AKWEL_Devis_09-10-2026_14-32-05.pdf')).toBe(
      'AKWEL_Devis_09-10-2026',
    );
    expect(shortDocName('scan facture.pdf')).toBe('scan facture.pdf');
  });

  it('tri numérique : T963 avant T1000, refs non T à la fin', () => {
    expect(['T1000', 'DI3', 'T963', 'T5'].sort(compareIdnum)).toEqual([
      'T5',
      'T963',
      'T1000',
      'DI3',
    ]);
  });

  it('date de réception = jour civil à Tunis (00:30 Tunis = veille en UTC)', () => {
    // 2026-03-09T23:30Z = 10/03/2026 00:30 à Tunis (UTC+1).
    expect(toExcelDay(new Date('2026-03-09T23:30:00Z'))).toEqual(
      new Date(Date.UTC(2026, 2, 10)),
    );
  });
});

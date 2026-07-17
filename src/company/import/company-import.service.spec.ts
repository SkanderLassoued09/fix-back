import * as XLSX from 'xlsx';
import { CompanyImportService } from './company-import.service';
import { EXPORT_HEADERS, companyToRow } from './company-io';

/** Construit un buffer .xlsx à partir d'une matrice (en-têtes + lignes). */
function xlsxBuffer(aoa: any[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Lit un buffer .xlsx → matrice de chaînes. */
function readAoa(buf: Buffer): string[][] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
}

describe('CompanyImportService — export / import xlsx', () => {
  function makeSvc(
    index: Array<{ _id: string; mf?: string; raisonSociale?: string }> = [],
    exportRows: any[] = [],
  ) {
    const companyService: any = {
      loadImportMatchIndex: jest.fn().mockResolvedValue(index),
      exportAllCompanies: jest.fn().mockResolvedValue(exportRows),
      findOneCompany: jest.fn(),
      createFromImport: jest.fn().mockResolvedValue('NEW_ID'),
      updateFromImport: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new CompanyImportService(companyService);
    return { svc, companyService };
  }

  const FULL_COMPANY = {
    _id: 'C1',
    name: 'ACME',
    raisonSociale: 'ACME SARL',
    region: 'Tunis',
    address: '12 rue',
    email: 'contact@acme.tn',
    phone: '+216 71 000 000',
    fax: '+216 71 000 001',
    webSiteLink: 'https://acme.tn',
    mf: 'MF-1',
    rne: 'B01',
    Exoneration: 'Non',
    activitePrincipale: 'Distribution',
    activiteSecondaire: 'Maintenance',
    serviceAchat: { name: 'Achat X', email: 'achat@acme.tn', phone: '+216 71 1' },
    serviceTechnique: { name: 'Tech Y', email: 'tech@acme.tn', phone: '+216 71 2' },
    serviceFinancier: { name: 'Fin Z', email: 'fin@acme.tn', phone: '+216 71 3' },
  };

  // ── EXPORT ──────────────────────────────────────────────────────────────

  it('export : bons en-têtes (schéma canonique) + données correctes', async () => {
    const { svc } = makeSvc([], [FULL_COMPANY]);
    const buf = await svc.exportAll();
    const aoa = readAoa(buf);

    expect(aoa[0]).toEqual(EXPORT_HEADERS); // 22 colonnes, ordre exact
    expect(aoa[1]).toEqual(companyToRow(FULL_COMPANY));
    // Contacts embedded bien à plat dans les colonnes dédiées.
    const iAchatNom = EXPORT_HEADERS.indexOf('Contact Achat Nom');
    expect(aoa[1][iAchatNom]).toBe('Achat X');
  });

  it('export : la chaîne legacy "undefined" est nettoyée en cellule vide', async () => {
    const { svc } = makeSvc([], [{ raisonSociale: 'undefined', name: 'X' }]);
    const aoa = readAoa(await svc.exportAll());
    const iRs = EXPORT_HEADERS.indexOf('Raison sociale');
    expect(aoa[1][iRs]).toBe('');
  });

  // ── IMPORT ──────────────────────────────────────────────────────────────

  it('import valide → CRÉE (aucune correspondance existante)', async () => {
    const { svc, companyService } = makeSvc([]);
    const buf = xlsxBuffer([
      EXPORT_HEADERS,
      ['NOUV', 'NOUVELLE CO', 'Tunis', 'adr', 'a@b.tn', '+216 71 0', '', '', 'MF-9', '', 'Oui', '', '', 'AN', 'an@b.tn', '', '', '', '', '', '', ''],
    ]);
    const rep = await svc.run(buf, { dryRun: false });

    expect(rep.enTeteInvalide).toBeFalsy();
    expect(rep.aCreer).toBe(1);
    expect(rep.aMettreAJour).toBe(0);
    expect(companyService.createFromImport).toHaveBeenCalledTimes(1);
    const doc = companyService.createFromImport.mock.calls[0][0];
    expect(doc.raisonSociale).toBe('NOUVELLE CO');
    expect(doc.name).toBe('NOUV'); // Nom et Raison sociale distincts (2 colonnes)
    expect(doc.serviceAchat).toEqual({ name: 'AN', email: 'an@b.tn', phone: '' });
    expect(rep.crees).toEqual({ crees: 1, majs: 0, erreurs: 0 });
  });

  it('import → MET À JOUR par Matricule fiscale (upsert)', async () => {
    const { svc, companyService } = makeSvc([
      { _id: 'C1', mf: 'MF-1', raisonSociale: 'ANCIEN NOM' },
    ]);
    const row = companyToRow(FULL_COMPANY); // mf MF-1 → doit matcher C1
    const rep = await svc.run(xlsxBuffer([EXPORT_HEADERS, row]), { dryRun: false });

    expect(rep.aMettreAJour).toBe(1);
    expect(rep.aCreer).toBe(0);
    expect(companyService.updateFromImport).toHaveBeenCalledWith('C1', expect.any(Object));
    expect(companyService.createFromImport).not.toHaveBeenCalled();
  });

  it('import → MET À JOUR par Raison sociale (insensible casse) si pas de MF', async () => {
    const { svc, companyService } = makeSvc([
      { _id: 'C7', mf: '', raisonSociale: 'Beta SARL' },
    ]);
    const buf = xlsxBuffer([
      EXPORT_HEADERS,
      ['', 'BETA SARL', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const rep = await svc.run(buf, { dryRun: false });
    expect(rep.aMettreAJour).toBe(1);
    expect(companyService.updateFromImport).toHaveBeenCalledWith('C7', expect.any(Object));
  });

  it('lignes invalides : les bonnes passent, les mauvaises rejetées AVEC raison', async () => {
    const { svc, companyService } = makeSvc([]);
    const buf = xlsxBuffer([
      EXPORT_HEADERS,
      ['A', 'VALIDE CO', '', '', '', '', '', '', 'MF-A', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['B', '', '', '', '', '', '', '', 'MF-B', '', '', '', '', '', '', '', '', '', '', '', '', ''], // raison sociale manquante
    ]);
    const rep = await svc.run(buf, { dryRun: false });

    expect(rep.total).toBe(2);
    expect(rep.valides).toBe(1);
    expect(rep.erreurs).toHaveLength(1);
    expect(rep.erreurs[0].motifs.join(' ')).toMatch(/Raison sociale manquante/i);
    expect(companyService.createFromImport).toHaveBeenCalledTimes(1); // seule la bonne écrite
  });

  it('dryRun = APERÇU : aucune écriture', async () => {
    const { svc, companyService } = makeSvc([]);
    const buf = xlsxBuffer([
      EXPORT_HEADERS,
      ['X', 'PREVIEW CO', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const rep = await svc.run(buf, { dryRun: true });
    expect(rep.aCreer).toBe(1);
    expect(companyService.createFromImport).not.toHaveBeenCalled();
    expect(companyService.updateFromImport).not.toHaveBeenCalled();
    expect(rep.crees).toBeUndefined();
  });

  it('ROUND-TRIP idempotent : réimporter l\'export ne duplique pas (upsert)', async () => {
    // 1) export
    const { svc: exporter } = makeSvc([], [FULL_COMPANY]);
    const exported = await exporter.exportAll();
    // 2) réimport, la société existe déjà (même mf)
    const { svc, companyService } = makeSvc([
      { _id: 'C1', mf: 'MF-1', raisonSociale: 'ACME SARL' },
    ]);
    const rep = await svc.run(exported, { dryRun: false });

    expect(rep.aCreer).toBe(0); // rien de créé
    expect(rep.aMettreAJour).toBe(1); // simple mise à jour
    expect(companyService.createFromImport).not.toHaveBeenCalled();
    expect(companyService.updateFromImport).toHaveBeenCalledTimes(1);
  });

  it('en-tête invalide : « Raison sociale » absente → rejet propre (aucune écriture)', async () => {
    const { svc, companyService } = makeSvc([]);
    const buf = xlsxBuffer([['Nom', 'Ville'], ['ACME', 'Tunis']]);
    const rep = await svc.run(buf, { dryRun: false });
    expect(rep.enTeteInvalide).toBe(true);
    expect(rep.erreurs[0].motifs[0]).toMatch(/Raison sociale/i);
    expect(companyService.createFromImport).not.toHaveBeenCalled();
  });

  it('doublon intra-fichier (même MF) → 2e ligne en erreur', async () => {
    const { svc } = makeSvc([]);
    const buf = xlsxBuffer([
      EXPORT_HEADERS,
      ['', 'CO 1', '', '', '', '', '', '', 'MF-DUP', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['', 'CO 2', '', '', '', '', '', '', 'MF-DUP', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const rep = await svc.run(buf, { dryRun: true });
    expect(rep.valides).toBe(1);
    expect(rep.erreurs.some((e) => /Doublon dans le fichier/i.test(e.motifs.join(' ')))).toBe(true);
  });
});

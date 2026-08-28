// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';

/**
 * Garde serveur sur le prix du diagnostic (feat/prix-diagnostic-tarification).
 * Après le retrait des bornes 150–500 (front, décision commerciale), le back
 * garde deux invariants monétaires :
 *   - DI PAYANTE  → prix STRICTEMENT POSITIF requis (refus 0 / négatif / NaN) ;
 *   - DI NON PAYANTE → aucun prix positif facturable (garde existante).
 * AUCUNE borne 150–500 côté back : une valeur hors bornes est acceptée.
 */

function makeSvc(di: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.diModel = {
    findOne: jest.fn().mockResolvedValue(di),
    findOneAndUpdate: jest
      .fn()
      .mockImplementation((_f: any, u: any) =>
        Promise.resolve({ ...di, price: u?.$set?.price }),
      ),
  };
  svc.logsDiService = { savePricing: jest.fn().mockResolvedValue({}) };
  svc.discordHookService = {
    sendDiPriceAssigned: jest.fn().mockResolvedValue(undefined),
  };
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.affectinitialPrice — garde prix diagnostic', () => {
  it('PAYANT + prix > 0 → écrit le prix', async () => {
    const svc = makeSvc({ _id: 'DI1', diagnosticPayant: true, ignoreCount: 0 });
    await svc.affectinitialPrice('DI1', 200);
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'DI1' },
      { $set: { price: 200 } },
      { new: true },
    );
  });

  it('PAYANT + prix = 0 → REFUS (montant strictement positif requis)', async () => {
    const svc = makeSvc({ _id: 'DI1', diagnosticPayant: true, ignoreCount: 0 });
    await expect(svc.affectinitialPrice('DI1', 0)).rejects.toThrow(
      /strictement positif|invalide/,
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('PAYANT + prix négatif → REFUS', async () => {
    const svc = makeSvc({ _id: 'DI1', diagnosticPayant: true, ignoreCount: 0 });
    await expect(svc.affectinitialPrice('DI1', -50)).rejects.toThrow(
      /strictement positif|invalide/,
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('PAYANT + hors-bornes (600) → ACCEPTÉ (aucune borne 150–500 côté back)', async () => {
    const svc = makeSvc({ _id: 'DI1', diagnosticPayant: true, ignoreCount: 0 });
    await svc.affectinitialPrice('DI1', 600);
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'DI1' },
      { $set: { price: 600 } },
      { new: true },
    );
  });

  it('NON PAYANT + prix 0 → OK (no-op toléré, aucune facturation)', async () => {
    const svc = makeSvc({ _id: 'DI1', diagnosticPayant: false, ignoreCount: 0 });
    await svc.affectinitialPrice('DI1', 0);
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'DI1' },
      { $set: { price: 0 } },
      { new: true },
    );
  });

  it('NON PAYANT + prix > 0 → REFUS (garde existante préservée)', async () => {
    const svc = makeSvc({ _id: 'DI1', diagnosticPayant: false, ignoreCount: 0 });
    await expect(svc.affectinitialPrice('DI1', 200)).rejects.toThrow(
      /non payant/,
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

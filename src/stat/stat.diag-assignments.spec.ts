import { StatService } from './stat.service';
import { ForbiddenException } from '@nestjs/common';

/**
 * Historique d'affectation diagnostic (abandon → réaffectation) sur `Stat` :
 *  - `recordDiagAbandon` clôt l'entrée ouverte (motif/qui/quand + contribution)
 *    et NE réinitialise PAS `diag_time` (facturation A+B cumulée) ;
 *  - `createStat` réaffecte EN PLACE (pas de doublon) en ouvrant une entrée,
 *    et REFUSE le même tech déjà affecté sur le cycle (blocage post-abandon).
 */

// ── recordDiagAbandon ────────────────────────────────────────────────────
function makeAbandonSvc(stat: any) {
  const svc: any = Object.create(StatService.prototype);
  // closeDiagLeg est testé ailleurs (fige diag_time au leg courant). Ici on le
  // neutralise : on prouve que recordDiagAbandon ne REMET PAS diag_time à zéro.
  svc.closeDiagLeg = jest.fn().mockResolvedValue(null);
  svc.StatModel = { findOne: jest.fn(async () => stat) };
  return svc;
}

describe('StatService.recordDiagAbandon', () => {
  it('clôt l’entrée ouverte (motif/qui/quand + contribution) et NE reset PAS diag_time', async () => {
    const stat: any = {
      _id: 'S1',
      _idDi: 'DI1',
      id_tech_diag: 'A',
      ignoreCount: 0,
      diag_time: '00:30:00', // temps déjà cumulé par A
      diagAssignments: [
        {
          tech: 'A',
          assignedAt: new Date('2026-01-01T09:00:00Z'),
          abandonedAt: null,
          motif: null,
          abandonedBy: null,
          diagTimeStart: '00:00:00',
          diagTime: null,
        },
      ],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(true),
    };
    const svc = makeAbandonSvc(stat);

    const ok = await svc.recordDiagAbandon(
      'DI1',
      0,
      'Panne non identifiable',
      'tech.bob',
    );

    expect(ok).toBe(true);
    const entry = stat.diagAssignments[0];
    expect(entry.abandonedAt).toBeTruthy();
    expect(entry.motif).toBe('Panne non identifiable');
    expect(entry.abandonedBy).toBe('tech.bob');
    expect(entry.diagTime).toBe('00:30:00'); // contribution de A (affichage)
    expect(stat.diag_time).toBe('00:30:00'); // CUMULATIF — jamais remis à 0
    expect(stat.save).toHaveBeenCalledTimes(1);
  });

  it('sans entrée ouverte (données héritées) → crée une entrée clôturée depuis id_tech_diag', async () => {
    const stat: any = {
      _idDi: 'DI1',
      id_tech_diag: 'A',
      diag_time: '00:10:00',
      diagAssignments: [],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(true),
    };
    const svc = makeAbandonSvc(stat);
    await svc.recordDiagAbandon('DI1', 0, 'Documentation indisponible', 'tech.bob');
    expect(stat.diagAssignments).toHaveLength(1);
    expect(stat.diagAssignments[0].tech).toBe('A');
    expect(stat.diagAssignments[0].abandonedAt).toBeTruthy();
  });
});

// ── createStat : réaffectation EN PLACE + blocage même-tech ──────────────
function makeCreateSvc(existingStat: any, di: any) {
  const svc: any = Object.create(StatService.prototype);
  svc.diModel = { findOne: jest.fn(async () => di) };
  svc.generateStatId = jest.fn().mockResolvedValue(1);
  const StatModel: any = jest.fn(); // constructeur (chemin création — non utilisé ici)
  StatModel.findOne = jest.fn(async () => existingStat);
  svc.StatModel = StatModel;
  svc.logsDiService = { create: jest.fn() };
  svc.profileService = { findProlileById: jest.fn().mockResolvedValue({}) };
  svc.notificationGateway = { updateTicket: jest.fn() };
  svc.operationalErrorService = { capture: jest.fn() };
  return svc;
}

function makeExistingStat(abandonedTech: string) {
  return {
    _id: 'S1',
    _idDi: 'DI1',
    id_tech_diag: abandonedTech,
    diag_time: '00:30:00',
    ignoreCount: 0,
    diagAssignments: [
      {
        tech: abandonedTech,
        assignedAt: new Date('2026-01-01T09:00:00Z'),
        abandonedAt: new Date('2026-01-01T09:30:00Z'),
        motif: 'Panne non identifiable',
        abandonedBy: 'tech.alice',
        diagTimeStart: '00:00:00',
        diagTime: '00:30:00',
      },
    ],
    markModified: jest.fn(),
    save: jest.fn().mockResolvedValue(true),
    toObject() {
      return { ...this };
    },
  };
}

describe('StatService.createStat — réaffectation post-abandon', () => {
  it('réaffecte un AUTRE tech EN PLACE (pas de doublon) → chaîne complète A→B', async () => {
    const existing = makeExistingStat('A');
    const svc = makeCreateSvc(existing, { status: 'PENDING1', ignoreCount: 0 });

    await svc.createStat({ _idDi: 'DI1', id_tech_diag: 'B' } as any);

    // le constructeur (chemin création) NE doit PAS être appelé
    expect(svc.StatModel).not.toHaveBeenCalled();
    expect(existing.id_tech_diag).toBe('B'); // pointeur courant mis à jour
    expect(existing.diagAssignments).toHaveLength(2); // A (abandonné) + B (ouvert)
    expect(existing.diagAssignments[0].tech).toBe('A');
    expect(existing.diagAssignments[0].abandonedAt).toBeTruthy();
    expect(existing.diagAssignments[1].tech).toBe('B');
    expect(existing.diagAssignments[1].abandonedAt).toBeNull(); // nouvelle affectation ouverte
    expect(existing.save).toHaveBeenCalled();
  });

  it('REFUSE le MÊME tech déjà affecté sur ce cycle (Forbidden, non journalisé)', async () => {
    const existing = makeExistingStat('A');
    const svc = makeCreateSvc(existing, { status: 'PENDING1', ignoreCount: 0 });

    await expect(
      svc.createStat({ _idDi: 'DI1', id_tech_diag: 'A' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(existing.save).not.toHaveBeenCalled();
    // rejet métier attendu → PAS d'erreur opérationnelle
    expect(svc.operationalErrorService.capture).not.toHaveBeenCalled();
  });
});

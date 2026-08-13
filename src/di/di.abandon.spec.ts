// DiService/DiResolver tirent nanoid (ESM) → mock, comme les autres specs DI.
jest.mock('nanoid', () => ({ nanoid: () => 'rand' }));

import { DiResolver } from './di.resolver';
import { DiService } from './di.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { assertDiTransition } from './workflow/di-transition-guard';

/**
 * Feature — ABANDON du diagnostic (le tech rend la DI à la coordination).
 *  - AUTHENTIFIÉE (`@UseGuards(JwtAuthGuard)`) → `abandonedBy` = utilisateur ;
 *  - possible UNIQUEMENT depuis DIAGNOSTIC/INDIAGNOSTIC/DIAGNOSTIC_Pause
 *    (API directe comprise) → la règle Retour ne peut pas être contournée ;
 *  - motif OBLIGATOIRE (liste blanche ; « AUTRE » ⇒ texte libre requis) ;
 *  - DI → PENDING1 via la transition `TECH_ABANDON_TO_PENDING1`.
 */

// ── Resolver : garde + délégation ────────────────────────────────────────
function makeResolver() {
  const diService = {
    abandonDi: jest.fn().mockResolvedValue({ _id: 'DI1', status: 'PENDING1' }),
  };
  const resolver = new DiResolver(
    diService as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { resolver, diService };
}

describe('DiResolver.abandonDi — auth + délégation', () => {
  it('est protégée par JwtAuthGuard (sans token → refusée)', () => {
    const guards =
      Reflect.getMetadata('__guards__', DiResolver.prototype.abandonDi) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });

  it('délègue avec abandonedBy = username de l’utilisateur courant', async () => {
    const { resolver, diService } = makeResolver();
    await resolver.abandonDi(
      { diId: 'DI1', motif: 'PANNE_NON_IDENTIFIABLE' } as any,
      { _id: 'U1', username: 'tech.bob' } as any,
    );
    expect(diService.abandonDi).toHaveBeenCalledWith('DI1', {
      motif: 'PANNE_NON_IDENTIFIABLE',
      motifAutre: undefined,
      abandonedBy: 'tech.bob',
    });
  });
});

// ── Service : gardes de statut + motif + orchestration ───────────────────
function makeSvc(status: string | null = 'INDIAGNOSTIC', ignoreCount = 0) {
  const svc: any = Object.create(DiService.prototype);
  svc.diModel = {
    findOne: () => ({
      select: () => ({
        lean: async () => (status === null ? null : { status, ignoreCount }),
      }),
    }),
  };
  svc.statsService = { recordDiagAbandon: jest.fn().mockResolvedValue(true) };
  svc.diWorkflowService = {
    transition: jest
      .fn()
      .mockResolvedValue({ di: { _id: 'DI1', status: 'PENDING1' } }),
  };
  svc.discordHookService = { sendDiAbandoned: jest.fn().mockResolvedValue({}) };
  svc.captureDiscordFailure = jest.fn();
  return svc;
}
const baseData = { motif: 'PANNE_NON_IDENTIFIABLE', abandonedBy: 'tech.bob' };

describe('DiService.abandonDi — gardes & orchestration', () => {
  it('INDIAGNOSTIC + motif valide → recordDiagAbandon + transition PENDING1 + notif', async () => {
    const svc = makeSvc('INDIAGNOSTIC', 0);
    const di = await svc.abandonDi('DI1', baseData);
    expect(svc.statsService.recordDiagAbandon).toHaveBeenCalledWith(
      'DI1',
      0,
      'Panne non identifiable', // libellé serveur
      'tech.bob',
    );
    expect(svc.diWorkflowService.transition).toHaveBeenCalledWith({
      diId: 'DI1',
      transitionKey: 'TECH_ABANDON_TO_PENDING1',
    });
    expect(svc.discordHookService.sendDiAbandoned).toHaveBeenCalledTimes(1);
    expect(di.status).toBe('PENDING1');
  });

  it('DIAGNOSTIC_Pause est abandonnable', async () => {
    const svc = makeSvc('DIAGNOSTIC_Pause', 0);
    await svc.abandonDi('DI1', baseData);
    expect(svc.diWorkflowService.transition).toHaveBeenCalled();
  });

  it('statut NON-diagnostic (PENDING1) → refus, AUCUNE transition (API directe)', async () => {
    const svc = makeSvc('PENDING1', 0);
    await expect(svc.abandonDi('DI1', baseData)).rejects.toThrow(
      /pas en cours de diagnostic/i,
    );
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
    expect(svc.statsService.recordDiagAbandon).not.toHaveBeenCalled();
  });

  it('statut RETOUR1 → refus (règle Retour NON contournée)', async () => {
    const svc = makeSvc('RETOUR1', 1);
    await expect(svc.abandonDi('DI1', baseData)).rejects.toThrow(
      /pas en cours de diagnostic/i,
    );
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
  });

  it('motif « AUTRE » sans texte → refus, aucune transition', async () => {
    const svc = makeSvc('DIAGNOSTIC', 0);
    await expect(
      svc.abandonDi('DI1', { motif: 'AUTRE', motifAutre: '   ', abandonedBy: 'x' }),
    ).rejects.toThrow(/Autre.*obligatoire/i);
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
  });

  it('motif inconnu → refus', async () => {
    const svc = makeSvc('DIAGNOSTIC', 0);
    await expect(
      svc.abandonDi('DI1', { motif: 'HACK', abandonedBy: 'x' }),
    ).rejects.toThrow(/invalide/i);
  });

  it('DI introuvable → NOT_FOUND', async () => {
    const svc = makeSvc(null, 0);
    await expect(svc.abandonDi('DI1', baseData)).rejects.toThrow(/introuvable/i);
  });
});

// ── Garde générique M1 : NON touché par l'abandon (pas de chemin non voulu) ─
// L'abandon emprunte la transition dédiée `TECH_ABANDON_TO_PENDING1`
// (`strictFrom`) + le check explicite d'`abandonDi` ; il ne passe PAS par
// `assertDiTransition`. Le garde-fou « pas de retour arrière accidentel vers
// PENDING1 » reste donc INTACT pour toute autre mutation.
describe('assertDiTransition — garde-fou PENDING1 préservé', () => {
  it('REFUSE toujours INDIAGNOSTIC/DIAGNOSTIC → PENDING1 par le garde générique', () => {
    expect(() => assertDiTransition('INDIAGNOSTIC', 'PENDING1')).toThrow(
      /Transition non autorisée/i,
    );
    expect(() => assertDiTransition('DIAGNOSTIC', 'PENDING1')).toThrow(
      /Transition non autorisée/i,
    );
  });

  it('AUTORISE les sources légitimes de PENDING1 (CREATED, PRICING)', () => {
    expect(() => assertDiTransition('CREATED', 'PENDING1')).not.toThrow();
    expect(() => assertDiTransition('PRICING', 'PENDING1')).not.toThrow();
  });
});

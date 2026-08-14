// DiService importe nanoid (ESM) → mock, comme les autres specs DI.
jest.mock('nanoid', () => ({ nanoid: () => 'rand' }));

import { DiService } from './di.service';

/**
 * Contrat de câblage des hand-offs : chaque site appelle le POINT CENTRAL
 * (`emitDiHandoff` → `notificationService.emit`) UNE fois, avec le bon
 * destinataire (roles) et l'acteur. L'EXCLUSION de l'acteur + le ciblage + l'écriture
 * d'historique sont prouvés au niveau `NotificationService` (notification.service.spec) ;
 * ici on prouve que le site transmet correctement acteur + rôles.
 */
function makeSvc(emitImpl?: any) {
  const svc: any = Object.create(DiService.prototype);
  const emit = emitImpl ?? jest.fn().mockResolvedValue({});
  svc.notificationService = { emit };
  svc.captureDiscordFailure = jest.fn();
  return { svc, emit };
}

describe('DiService.emitDiHandoff — contrat de câblage', () => {
  it('UN SEUL emit, avec destinataire (roles) + acteur transmis (ex. pricing)', async () => {
    const { svc, emit } = makeSvc();
    await svc.emitDiHandoff(
      'DI1',
      { _idnum: 'T9', status: 'PRICING' },
      'DI_PRICING',
      'Prix à fixer',
      ['Admin_Manager', 'Admin_Tech'],
      { id: 'U1' },
    );
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0][0];
    expect(arg.type).toBe('DI_PRICING');
    expect(arg.diId).toBe('DI1');
    // l'acteur est transmis → `emit` l'exclut de ses propres notifications
    expect(arg.actorId).toBe('U1');
    expect(arg.notify).toEqual({ roles: ['Admin_Manager', 'Admin_Tech'] });
  });

  it('acteur INCONNU par défaut (actorId=null) sur un site non authentifié', async () => {
    const { svc, emit } = makeSvc();
    await svc.emitDiHandoff('DI1', { _idnum: 'T9' }, 'DI_PENDING1', 'm', [
      'Coordinator',
    ]);
    expect(emit.mock.calls[0][0].actorId).toBeNull();
  });

  it('best-effort : un échec de notification n’échoue JAMAIS la transition', async () => {
    const emit = jest.fn().mockRejectedValue(new Error('down'));
    const { svc } = makeSvc(emit);
    await expect(
      svc.emitDiHandoff('DI1', {}, 'X', 'm', ['Coordinator']),
    ).resolves.toBeUndefined();
    expect(svc.captureDiscordFailure).toHaveBeenCalled();
  });
});

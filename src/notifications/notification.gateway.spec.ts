import { NotificationsGateway } from '../notification.gateway';

/**
 * Preuve : `updateTicket` reste un BROADCAST inchangé (zéro régression), tandis
 * que les notifications personnelles (`emitToUser`) partent vers une ROOM
 * ciblée `user:{id}` — jamais en broadcast.
 */
function makeGateway() {
  const roomEmit = jest.fn();
  const gw = new NotificationsGateway();
  (gw as any).server = {
    emit: jest.fn(), // broadcast à tous
    to: jest.fn(() => ({ emit: roomEmit })), // émission ciblée par room
  };
  return { gw, roomEmit };
}

describe('NotificationsGateway — broadcast vs ciblé', () => {
  it('updateTicket = BROADCAST inchangé (server.emit à tous)', () => {
    const { gw } = makeGateway();
    const msg = { action: 'updateState', content: { x: 1 } };
    gw.updateTicket(msg);
    expect((gw as any).server.emit).toHaveBeenCalledWith('updateTicket', msg);
    // pas de room pour updateTicket
    expect((gw as any).server.to).not.toHaveBeenCalled();
  });

  it('emitToUser = CIBLÉ vers la room `user:{id}` (jamais broadcast)', () => {
    const { gw, roomEmit } = makeGateway();
    gw.emitToUser('U42', { message: 'hello' });
    expect((gw as any).server.to).toHaveBeenCalledWith('user:U42');
    expect(roomEmit).toHaveBeenCalledWith('notification.new', {
      message: 'hello',
    });
    // n'utilise PAS le broadcast
    expect((gw as any).server.emit).not.toHaveBeenCalled();
  });

  it('emitToUser sans userId = no-op (pas d’émission)', () => {
    const { gw } = makeGateway();
    gw.emitToUser('', { a: 1 });
    expect((gw as any).server.to).not.toHaveBeenCalled();
  });
});

const { createRouter } = require('../router');

describe('Router', () => {
  let router;
  let mockIo;
  const clientA = { id: 'sock1', discordUsername: 'Tanguy', emit: jest.fn() };
  const clientB = { id: 'sock2', discordUsername: 'Pote1', emit: jest.fn() };

  beforeEach(() => {
    mockIo = { sockets: { sockets: new Map([['sock1', clientA], ['sock2', clientB]]) } };
    router = createRouter(mockIo);
    clientA.emit.mockClear();
    clientB.emit.mockClear();
  });

  test('broadcast envoie à tous les clients', () => {
    const event = { media: { type: 'image', url: 'http://x.com/a.png' }, audio: null, effects: [], target: null };
    router.dispatch(event);
    expect(clientA.emit).toHaveBeenCalledWith('drop', event);
    expect(clientB.emit).toHaveBeenCalledWith('drop', event);
  });

  test('ciblage envoie uniquement à la cible', () => {
    router.dispatch({ media: { type: 'emoji', url: '💀' }, audio: null, effects: [], target: 'Pote1' });
    expect(clientA.emit).not.toHaveBeenCalled();
    expect(clientB.emit).toHaveBeenCalledWith('drop', expect.objectContaining({ media: { type: 'emoji', url: '💀' } }));
  });

  test('ciblage sur username inexistant ne crash pas', () => {
    expect(() => {
      router.dispatch({ media: null, audio: { type: 'sfx', url: 'sfx:airhorn' }, effects: [], target: 'Inconnu' });
    }).not.toThrow();
  });
});

const { checkSendAuth } = require('../sendAuth');

describe('checkSendAuth', () => {
  test('pas de mot de passe configuré → ouvert, gate non requis', () => {
    expect(checkSendAuth('whatever', undefined)).toEqual({ ok: true, required: false });
    expect(checkSendAuth('', '')).toEqual({ ok: true, required: false });
  });

  test('mot de passe correct → ok, required', () => {
    expect(checkSendAuth('hunter2', 'hunter2')).toEqual({ ok: true, required: true });
  });

  test('mot de passe vide pendant le probe → refusé, required (montre le gate)', () => {
    expect(checkSendAuth('', 'hunter2')).toEqual({ ok: false, required: true });
    expect(checkSendAuth(undefined, 'hunter2')).toEqual({ ok: false, required: true });
  });

  test('mauvais mot de passe → refusé, required', () => {
    expect(checkSendAuth('nope', 'hunter2')).toEqual({ ok: false, required: true });
  });
});

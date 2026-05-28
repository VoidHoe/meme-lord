const { parseMessage } = require('../bot');

describe('parseMessage', () => {
  function makeMsg(overrides = {}) {
    return {
      content: '',
      attachments: new Map(),
      mentions: { users: new Map() },
      author: { bot: false },
      ...overrides,
    };
  }

  test('image attachement → media image', () => {
    const attachments = new Map([['1', { url: 'http://cdn.discord.com/a.png', contentType: 'image/png', flags: 0 }]]);
    const result = parseMessage(makeMsg({ attachments }));
    expect(result).toMatchObject({ media: { type: 'image', url: 'http://cdn.discord.com/a.png' }, audio: null, target: null });
  });

  test('GIF attachement → media gif', () => {
    const attachments = new Map([['1', { url: 'http://cdn.discord.com/a.gif', contentType: 'image/gif', flags: 0 }]]);
    const result = parseMessage(makeMsg({ attachments }));
    expect(result.media.type).toBe('gif');
  });

  test('voice message → audio voice', () => {
    // discord.js voice messages have flags = 8192 (AttachmentFlags.IsVoiceMessage)
    const attachments = new Map([['1', { url: 'http://cdn.discord.com/voice.ogg', contentType: 'audio/ogg', flags: 8192 }]]);
    const result = parseMessage(makeMsg({ attachments }));
    expect(result).toMatchObject({ media: null, audio: { type: 'voice', url: 'http://cdn.discord.com/voice.ogg' } });
  });

  test('/sound airhorn → sfx event', () => {
    const result = parseMessage(makeMsg({ content: '/sound airhorn' }));
    expect(result).toMatchObject({ media: null, audio: { type: 'sfx', url: 'sfx:airhorn' } });
  });

  test('/sound airhorn @Pote1 → sfx avec ciblage', () => {
    const users = new Map([['123', { username: 'Pote1' }]]);
    const result = parseMessage(makeMsg({ content: '/sound airhorn @Pote1', mentions: { users } }));
    expect(result).toMatchObject({ audio: { type: 'sfx', url: 'sfx:airhorn' }, target: 'Pote1' });
  });

  test('/react 💀 → emoji media', () => {
    const result = parseMessage(makeMsg({ content: '/react 💀' }));
    expect(result).toMatchObject({ media: { type: 'emoji', url: '💀' } });
  });

  test('URL YouTube → media youtube', () => {
    const result = parseMessage(makeMsg({ content: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
    expect(result).toMatchObject({ media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
  });

  test('message bot ignoré → null', () => {
    const result = parseMessage(makeMsg({ author: { bot: true } }));
    expect(result).toBeNull();
  });

  test('message texte sans commande → null', () => {
    const result = parseMessage(makeMsg({ content: 'hello les gars' }));
    expect(result).toBeNull();
  });
});

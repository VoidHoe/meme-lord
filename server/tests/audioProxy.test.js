const { resolveAudioUrl } = require('../audioProxy');

describe('resolveAudioUrl', () => {
  test('sfx: URL retournée telle quelle', async () => {
    const result = await resolveAudioUrl('sfx:airhorn', 'http://localhost:3000');
    expect(result).toBe('sfx:airhorn');
  });

  test('URL non-Discord retournée telle quelle', async () => {
    const result = await resolveAudioUrl('https://example.com/sound.mp3', 'http://localhost:3000');
    expect(result).toBe('https://example.com/sound.mp3');
  });
});

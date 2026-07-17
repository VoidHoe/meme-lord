const { resolveMedia } = require('../resolveMedia');

// Helper: a fake fetch returning a given JSON payload.
const fakeFetch = (payload) => async () => ({ json: async () => payload });
const throwingFetch = async () => { throw new Error('network down'); };

describe('resolveMedia', () => {
  test('URL vide → null', async () => {
    expect(await resolveMedia('', fakeFetch({}))).toBeNull();
    expect(await resolveMedia('   ', fakeFetch({}))).toBeNull();
  });

  test('image directe → type image', async () => {
    const m = await resolveMedia('https://x.com/a.png', fakeFetch({}));
    expect(m).toEqual({ type: 'image', url: 'https://x.com/a.png' });
  });

  test('gif directe → type gif', async () => {
    const m = await resolveMedia('https://x.com/a.gif', fakeFetch({}));
    expect(m.type).toBe('gif');
  });

  test('mp4/webm directe → type video', async () => {
    expect((await resolveMedia('https://x.com/a.mp4', fakeFetch({}))).type).toBe('video');
    expect((await resolveMedia('https://x.com/a.webm', fakeFetch({}))).type).toBe('video');
  });

  test('extension avec query string → type correct', async () => {
    const m = await resolveMedia('https://x.com/a.mp4?t=123', fakeFetch({}));
    expect(m.type).toBe('video');
  });

  test('YouTube → type youtube, url conservée', async () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const m = await resolveMedia(url, fakeFetch({}));
    expect(m).toEqual({ type: 'youtube', url });
  });

  test('Medal share link resolves from metadata', async () => {
    const fetchImpl = async () => ({
      ok: true,
      text: async () => '<meta property="og:video" content="https://medal.tv/api/content/abc/socialVideoUrl?v=1&amp;i=2">',
    });
    const m = await resolveMedia('https://medal.tv/games/dead-by-daylight/clips/abc?invite=test', fetchImpl);
    expect(m).toEqual({ type: 'video', url: 'https://medal.tv/api/content/abc/socialVideoUrl?v=1&i=2' });
  });

  test('Medal unavailable clip throws clear error', async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => '<html></html>' });
    await expect(resolveMedia('https://medal.tv/clips/private123', fetchImpl)).rejects.toThrow('private or unavailable');
  });

  test('TikTok résolu → video directe depuis tikwm', async () => {
    const fetchImpl = fakeFetch({ code: 0, data: { play: 'https://cdn.tikwm/v.mp4' } });
    const m = await resolveMedia('https://www.tiktok.com/@user/video/12345', fetchImpl);
    expect(m).toEqual({ type: 'video', url: 'https://cdn.tikwm/v.mp4' });
  });

  test('TikTok échec réseau → fallback embed', async () => {
    const m = await resolveMedia('https://www.tiktok.com/@user/video/12345', throwingFetch);
    expect(m.type).toBe('tiktok');
    expect(m.url).toContain('tiktok.com/embed');
  });

  test('Twitter avec vidéo → meilleure résolution', async () => {
    const fetchImpl = fakeFetch({ tweet: { media: { videos: [
      { url: 'lo.mp4', width: 320 },
      { url: 'hi.mp4', width: 1280 },
    ] } } });
    const m = await resolveMedia('https://twitter.com/bob/status/999', fetchImpl);
    expect(m).toEqual({ type: 'video', url: 'hi.mp4' });
  });

  test('Twitter sans vidéo mais photo → type image', async () => {
    const fetchImpl = fakeFetch({ tweet: { media: { photos: [{ url: 'pic.jpg' }] } } });
    const m = await resolveMedia('https://x.com/bob/status/999', fetchImpl);
    expect(m).toEqual({ type: 'image', url: 'pic.jpg' });
  });

  test('Twitter échec réseau → fallback embed', async () => {
    const m = await resolveMedia('https://twitter.com/bob/status/999', throwingFetch);
    expect(m.type).toBe('twitter');
    expect(m.url).toContain('id=999');
  });
});

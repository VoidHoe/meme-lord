const { playbackPlan, runDropTimeline } = require('../../overlay/playbackPlan');

describe('drop playback timeline', () => {
  test('full video starts attached audio with the clip, not after it ends', async () => {
    const order = [];
    const plan = await runDropTimeline(
      {
        media: { type: 'video', url: 'https://cdn.discordapp.com/gif.mp4' },
        audio: { type: 'voice', url: 'https://cdn.discordapp.com/voice.ogg' },
        loop: false,
      },
      { isVideo: true, isEmbed: false },
      {
        playAudio: () => order.push('audio'),
        wait: async (mode) => order.push(mode),
      },
    );

    expect(plan).toEqual({ mode: 'video', audioStart: 'with-media' });
    expect(order).toEqual(['audio', 'video']);
  });

  test('video without attached audio only waits for the clip', async () => {
    const order = [];
    await runDropTimeline(
      { media: { type: 'video' }, audio: null, loop: false },
      { isVideo: true },
      {
        playAudio: () => order.push('audio'),
        wait: async (mode) => order.push(mode),
      },
    );
    expect(order).toEqual(['video']);
  });

  test('trim wins over loop and still starts audio with the segment', async () => {
    const order = [];
    const plan = await runDropTimeline(
      { audio: { type: 'sfx', url: 'sfx:airhorn' }, loop: true, trimStart: 1, trimEnd: 4 },
      { isVideo: true },
      {
        playAudio: () => order.push('audio'),
        wait: async (mode) => order.push(mode),
      },
    );
    expect(plan.mode).toBe('trim');
    expect(order).toEqual(['audio', 'trim']);
  });

  test('looped video, embeds, and still images start audio with the visual', () => {
    expect(playbackPlan({ loop: true, audio: { type: 'voice' } }, { isVideo: true })).toEqual({
      mode: 'loop',
      audioStart: 'with-media',
    });
    expect(playbackPlan({ audio: { type: 'sfx' } }, { isEmbed: true })).toEqual({
      mode: 'embed',
      audioStart: 'with-media',
    });
    expect(playbackPlan({ media: { type: 'gif' }, audio: { type: 'voice' } })).toEqual({
      mode: 'still',
      audioStart: 'with-media',
    });
  });
});

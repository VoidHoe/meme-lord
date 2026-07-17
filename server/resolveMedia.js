// Resolve a pasted URL into a playable media object { type, url }.
// Server-side twin of overlay/main.js `resolveMedia` so the mobile /send page can
// drop TikTok / Twitter / YouTube / direct links without doing CORS-bound fetches
// from the phone browser. fetch is injectable so tests don't hit the network.
async function resolveMedia(url, fetchImpl = fetch) {
  if (!url || !url.trim()) return null;
  const clean = url.trim();
  const medalMatch = clean.match(/^https?:\/\/(?:www\.)?medal\.tv\/(?:games\/[^/?#]+\/)?clips?\/[\w-]+/i);
  const tiktokMatch  = clean.match(/tiktok\.com\/@[\w.]+\/video\/(\d+)/);
  const twitterMatch = clean.match(/(?:twitter\.com|x\.com)\/([\w]+)\/status\/(\d+)/);
  const youtubeMatch = clean.match(/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([\w-]+)/);
  let media = null;

  if (medalMatch) {
    const r = await fetchImpl(clean, { headers: { 'User-Agent': 'Mozilla/5.0 MemeDrop' } });
    if (!r.ok) throw new Error(`Medal returned ${r.status}`);
    const html = await r.text();
    const meta = html.match(/<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::secure_url)?|twitter:player:stream)["']/i);
    if (!meta?.[1]) throw new Error('This Medal clip is private or unavailable');
    media = { type: 'video', url: meta[1].replace(/&amp;/g, '&') };

  } else if (tiktokMatch) {
    try {
      const r = await fetchImpl(`https://www.tikwm.com/api/?url=${encodeURIComponent(clean)}`);
      const j = await r.json();
      if (j.code === 0 && j.data?.play) media = { type: 'video', url: j.data.play };
    } catch (e) {}
    if (!media) media = { type: 'tiktok', url: `https://www.tiktok.com/embed/v2/${tiktokMatch[1]}` };

  } else if (twitterMatch) {
    try {
      const [, username, tweetId] = twitterMatch;
      const r = await fetchImpl(`https://api.fxtwitter.com/${username}/status/${tweetId}`);
      const j = await r.json();
      const videos = j.tweet?.media?.videos || [];
      const best   = videos.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      if (best?.url) {
        media = { type: 'video', url: best.url };
      } else {
        const photo = (j.tweet?.media?.photos || [])[0];
        if (photo?.url) media = { type: 'image', url: photo.url };
      }
    } catch (e) {}
    if (!media) media = { type: 'twitter', url: `https://platform.twitter.com/embed/Tweet.html?id=${twitterMatch[2]}&theme=dark&dnt=true` };

  } else if (youtubeMatch) {
    media = { type: 'youtube', url: clean };

  } else {
    const ext = clean.split('.').pop().split('?')[0].toLowerCase();
    let type = 'image';
    if (ext === 'gif')                      type = 'gif';
    else if (['mp4', 'webm'].includes(ext)) type = 'video';
    media = { type, url: clean };
  }
  return media;
}

module.exports = { resolveMedia };

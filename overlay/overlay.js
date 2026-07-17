const container = document.getElementById('drop-container');
const badge     = document.getElementById('queue-badge');

let queue     = [];
let isPlaying = false;
let settings  = { positionX: 50, positionY: 50, duration: 5000, volumeSfx: 80, volumeVoice: 100 };


// Target box per size — media is scaled to FILL this box (small media upscaled,
// big media shrunk) so every drop lands at a consistent on-screen size.
function sizeBox(size) {
  const W = window.innerWidth, H = window.innerHeight;
  switch (size) {
    case 's':  return [240, 220];
    case 'l':  return [620, 520];
    case 'xl': return [Math.round(W * 0.82), Math.round(H * 0.82)];
    case 'm':
    default:   return [380, 340];
  }
}

// Effects, grouped by what they animate so they can stack without conflict:
//  ENTRANCE — one-shot transform, runs on the entrance wrapper at reveal
//  EMPHASIS — looping transform, runs on the emphasis wrapper the whole time
//  FILTER   — looping/one-shot CSS filter, runs on the media element itself
const FX_ENTRANCE = ['spin', 'drop', 'slide', 'zoom', 'flip', 'glitch', 'slam', 'bounce'];
const FX_EMPHASIS = ['shake', 'pulse', 'wobble', 'spin-loop', 'float'];
const FX_FILTER   = ['rainbow', 'glow', 'flash'];

window.memedrop.getSettings().then(s => { settings = s; applyPosition(); });
window.memedrop.onSettingsChanged(s => { settings = s; applyPosition(); });

window.memedrop.onDrop(event => {
  queue.push(event);
  updateBadge();
  if (!isPlaying) processQueue();
});

// Normalize the rendered size: scale media to fill its box on the dominant axis,
// keeping aspect ratio (small media is upscaled). Runs after the media has loaded
// so natural dimensions are known. Embeds (iframes) keep their fixed dimensions.
function applySize(mediaEl, size) {
  if (mediaEl.tagName !== 'IMG' && mediaEl.tagName !== 'VIDEO') return;
  const natW = mediaEl.tagName === 'IMG' ? mediaEl.naturalWidth  : mediaEl.videoWidth;
  const natH = mediaEl.tagName === 'IMG' ? mediaEl.naturalHeight : mediaEl.videoHeight;
  const [bw, bh] = sizeBox(size);
  if (!natW || !natH) {            // dims unknown → cap only, never upscale blindly
    container.style.maxWidth = bw + 'px';
    mediaEl.style.maxWidth  = '100%';
    mediaEl.style.maxHeight = bh + 'px';
    return;
  }
  const scale = Math.min(bw / natW, bh / natH);   // contain; upscales when smaller than the box
  const w = Math.round(natW * scale), h = Math.round(natH * scale);
  mediaEl.style.width     = w + 'px';
  mediaEl.style.height    = h + 'px';
  mediaEl.style.maxWidth  = 'none';
  mediaEl.style.maxHeight = 'none';
  container.style.maxWidth = w + 'px';
}

// Shrink a meme text block until it fits within maxH (a band of the image height),
// so a long caption scales down instead of covering the whole image.
function fitMemeText(el, startPx, maxH) {
  let size = startPx;
  el.style.fontSize = size + 'px';
  while (el.scrollHeight > maxH && size > 11) {
    size -= 1;
    el.style.fontSize = size + 'px';
  }
}

// ── Loudness normalization (Web Audio) ─────────────────────────────────────────
// Route audio through a compressor + makeup gain so quiet clips get louder and
// loud ones get tamed. Web Audio would SILENCE cross-origin media that isn't
// CORS-enabled, so we only route media that passes a CORS pre-flight; anything
// else falls back to plain playback (audible, just not evened out).
// Master volume — one knob that scales every audio path (video, SFX, voice, TTS).
function master() { return (settings.masterVolume ?? 100) / 100; }

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
const _normalized = new WeakSet();
function normalizeChain(el, baseVolume) {
  const ctx = getAudioCtx();
  if (!ctx || _normalized.has(el)) { el.volume = baseVolume; return false; }
  try {
    const src  = ctx.createMediaElementSource(el);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26; comp.knee.value = 24; comp.ratio.value = 12;
    comp.attack.value = 0.004; comp.release.value = 0.25;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, baseVolume) * 1.9;   // makeup gain, scaled by the user's volume
    src.connect(comp); comp.connect(gain); gain.connect(ctx.destination);
    _normalized.add(el);
    el._anodes = [src, comp, gain];   // kept so we can disconnect on cleanup
    el.volume = 1;   // master level is handled by the gain node now
    return true;
  } catch {
    el.volume = baseVolume;
    return false;
  }
}
async function corsAllowed(url) {
  try {
    const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, mode: 'cors' });
    try { r.body && r.body.cancel(); } catch {}
    return r.ok || r.status === 206 || r.status === 200;
  } catch { return false; }
}
// Set the video source (CORS-tagged when allowed) and wire up normalization.
async function setupVideoAudio(video) {
  const url = video.dataset.src;
  const baseVol = (settings.volumeSfx || 80) / 100 * master();
  let cors = false;
  try { cors = await corsAllowed(url); } catch {}
  if (cors) video.crossOrigin = 'anonymous';   // must be set before load to tag the resource
  video.src = url;
  if (cors && normalizeChain(video, baseVol)) return;
  video.volume = baseVol;
}

function applyPosition(overrideX, overrideY) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const px = overrideX != null ? overrideX : settings.positionX;
  const py = overrideY != null ? overrideY : settings.positionY;
  const cw = container.offsetWidth  || 240;
  const ch = container.offsetHeight || 180;
  const x = Math.round((px / 100) * vw - cw / 2);
  const y = Math.round((py / 100) * vh - ch / 2);
  // Keep the drop fully on screen even when it's large (XL near an edge).
  container.style.left = `${Math.min(Math.max(0, x), Math.max(0, vw - cw))}px`;
  container.style.top  = `${Math.min(Math.max(0, y), Math.max(0, vh - ch))}px`;
}

function updateBadge() {
  if (queue.length > 0) {
    badge.style.display  = 'block';
    badge.textContent    = `+${queue.length} en attente`;
  } else {
    badge.style.display  = 'none';
  }
}

async function processQueue() {
  if (queue.length === 0) { isPlaying = false; return; }
  isPlaying = true;

  const event = queue.shift();
  updateBadge();

  // Tryhard mode (per-receiver): force incoming drops into a small top-right
  // corner so they don't block gameplay (e.g. peeking in an FPS). Each person
  // toggles this for their own screen — it doesn't change what others see.
  const tryhard  = !!settings.tryhardMode;
  const dropSize = tryhard ? 's' : event.size;
  const dropX    = tryhard ? 85  : event.positionX;
  const dropY    = tryhard ? 15  : event.positionY;

  // Reset container
  container.innerHTML      = '';
  container.style.opacity  = '1';
  container.style.animation = '';
  container.style.display  = 'flex';
  container.style.maxWidth  = '';
  container.style.maxHeight = '';

  const fxList = event.effects || [];
  const legacyFade = fxList.includes('fade');
  const clampFade = (value, fallback = null) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(5, Math.max(0.1, parsed));
  };
  const fadeInSeconds = clampFade(event.fadeInDuration, legacyFade ? 3 : null);
  const fadeOutSeconds = clampFade(event.fadeOutDuration, legacyFade ? 3 : null);

  // Classic Impact meme: two lines of white outlined text laid over the image,
  // one at the top and one at the bottom. Falls back to a single bottom line for
  // older/mobile/deck drops that only carry `caption`.
  const isImageDrop = !!event.media && (event.media.type === 'image' || event.media.type === 'gif');
  const capTop      = isImageDrop ? (event.captionTop || null) : null;
  const capBottom   = isImageDrop ? (event.captionBottom || (event.captionTop ? null : event.caption) || null) : null;
  const memeCaption = isImageDrop && (capTop || capBottom);

  let mediaEl = null;
  let entranceLayer = null;   // receives the one-shot entrance transform at reveal time
  if (event.media) {
    mediaEl = buildMediaElement(event.media, event.loop);
    if (mediaEl) {
      if (mediaEl.tagName === 'VIDEO' && mediaEl.dataset.src) await setupVideoAudio(mediaEl);
      // Layered wrappers so a looping emphasis transform and a one-shot entrance
      // transform can run together without fighting over `transform`.
      entranceLayer = document.createElement('div'); entranceLayer.className = 'fx-layer';
      const emphasisLayer = document.createElement('div'); emphasisLayer.className = 'fx-layer';

      // The unit that receives entrance/emphasis fx is the whole meme frame when
      // captioned, so the image + overlaid text animate together as one.
      let unit = mediaEl;
      const memeTextEls = [];
      if (memeCaption) {
        const frame = document.createElement('div');
        frame.className = 'impact-frame';
        frame.appendChild(mediaEl);
        [['impact-top', capTop], ['impact-bottom', capBottom]].forEach(([pos, txt]) => {
          if (!txt) return;
          const el = document.createElement('div');
          el.className = 'impact-text ' + pos;
          el.textContent = txt;
          frame.appendChild(el);
          memeTextEls.push(el);
        });
        unit = frame;
      }

      entranceLayer.appendChild(unit);
      emphasisLayer.appendChild(entranceLayer);
      fxList.forEach(name => {
        if (FX_EMPHASIS.includes(name))    emphasisLayer.classList.add('fx-' + name);
        else if (FX_FILTER.includes(name)) mediaEl.classList.add('fx-' + name);
      });
      container.appendChild(emphasisLayer);
      await waitForMedia(mediaEl);
      applySize(mediaEl, dropSize);   // normalize size once natural dims are known

      // Keep each meme text inside a band at most ~40% of the image height so it
      // never covers the whole image; shrink the font to fit long captions.
      if (memeTextEls.length) {
        const startPx = Math.max(16, Math.min(46, Math.round((mediaEl.offsetWidth  || 0) * 0.11)));
        const bandH   = Math.max(24,             Math.round((mediaEl.offsetHeight || 0) * 0.40));
        memeTextEls.forEach(el => fitMemeText(el, startPx, bandH));
      }
    }
  }

  // Legacy floating pill for non-image drops (videos, embeds, emoji) or drops
  // that still carry a single caption instead of top/bottom meme text.
  if (event.caption && !memeCaption) {
    const cap = document.createElement('div');
    cap.className = 'drop-caption';
    cap.textContent = event.caption;
    container.appendChild(cap);
  }

  // Read whatever text the drop carries aloud.
  const spoken = event.caption || [capTop, capBottom].filter(Boolean).join(' ') || null;
  if (spoken) speakCaption(spoken);

  applyPosition(dropX, dropY);

  // Entrance effects + fade — applied on reveal so the animation reads cleanly.
  if (entranceLayer) fxList.forEach(name => { if (FX_ENTRANCE.includes(name)) entranceLayer.classList.add('fx-' + name); });
  if (fadeInSeconds) {
    container.style.animation = `fadeIn ${fadeInSeconds}s ease forwards`;
  }

  // Determine playback behavior
  const isVideo       = mediaEl && mediaEl.tagName === 'VIDEO';
  const isEmbed       = mediaEl && mediaEl.tagName === 'IFRAME';
  const VIDEO_CAP_MS  = 120000;  // play full video, but never hog the overlay past 2 min
  const EMBED_FULL_MS = 120000;  // embeds can't report their end — give them a long window

  const times   = Math.max(1, event.loopTimes || 1);
  const hasTrim = isVideo && event.trimEnd != null && event.trimEnd > (event.trimStart || 0);

  if (hasTrim) {
    // Play the trimmed segment [trimStart, trimEnd], repeated `times`
    if (event.audio) playAudio(event.audio);
    await playVideoSegment(mediaEl, event.trimStart || 0, event.trimEnd, times);
  } else if (event.loop === true) {
    // Legacy loop: first loopDuration seconds, repeated (kept for old history entries)
    const segSecs = event.loopDuration || 10;
    if (event.audio) playAudio(event.audio);
    if (isVideo) {
      await playVideoSegment(mediaEl, 0, segSecs, times);
    } else {
      await sleep(segSecs * times * 1000);
    }
  } else if (isVideo) {
    // Play the whole video once
    await new Promise(res => {
      mediaEl.addEventListener('ended', res, { once: true });
      setTimeout(res, VIDEO_CAP_MS);
    });
    if (event.audio) playAudio(event.audio);
  } else if (isEmbed) {
    // Play the whole embedded clip (best-effort fixed window).
    if (event.audio) playAudio(event.audio);
    // TikTok's embed is only the fallback when direct-video resolution fails, and
    // it now shows just a cookie-consent wall with no playback. Cap it to the normal
    // drop duration so it self-clears instead of pinning the overlay (and blocking
    // the whole queue) for 2 min. YouTube/Twitter embeds do play → keep the long window.
    const embedMs = (event.media && event.media.type === 'tiktok')
      ? (settings.duration || 5000)
      : EMBED_FULL_MS;
    await sleep(embedMs);
  } else {
    // image / gif / emoji
    if (event.audio) playAudio(event.audio);
    await sleep(settings.duration || 5000);
  }

  // Fade out
  if (fadeOutSeconds) {
    container.style.animation = `fadeOut ${fadeOutSeconds}s ease forwards`;
    await sleep(fadeOutSeconds * 1000);
  }

  container.style.display   = 'none';
  container.style.animation = '';
  const vid = container.querySelector('video');
  if (vid) {
    vid.pause();
    if (vid._anodes) { vid._anodes.forEach(n => { try { n.disconnect(); } catch {} }); vid._anodes = null; }
    vid.src = '';
  }
  container.innerHTML       = '';
  await sleep(200);
  processQueue();
}

// Build the TTS request URL for the chosen voice. Free, no API key.
function ttsUrl(voice, text) {
  const t = encodeURIComponent(text.slice(0, 200));
  switch (voice) {
    case 'g-en': return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${t}`;
    case 'g-fr': return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=fr&q=${t}`;
    case 'sam':  return `https://www.tetyys.com/SAPI4/SAPI4?text=${t}&voice=Sam&pitch=140&speed=150`;
    case 'mary': return `https://www.tetyys.com/SAPI4/SAPI4?text=${t}&voice=Mary&pitch=169&speed=170`;
    case 'mike': return `https://www.tetyys.com/SAPI4/SAPI4?text=${t}&voice=Mike&pitch=140&speed=150`;
    default:     return null;
  }
}

// Speak the caption. Main fetches the audio (sets a browser UA, dodges CORS) and
// hands back a data URL we just play.
async function speakCaption(text) {
  if (!text || !settings.ttsVoice) return;
  const url = ttsUrl(settings.ttsVoice, text);
  if (!url) return;
  try {
    const r = await window.memedrop.ttsFetch(url);
    if (!r || r.error || !r.dataUrl) throw new Error(r && r.error || 'tts failed');
    const a = new Audio(r.dataUrl);
    a.volume = Math.min(1, (settings.volumeVoice || 100) / 100 * master());
    a.play().catch(() => {});
  } catch (e) {
    console.warn('[TTS]', e);
  }
}

function buildMediaElement(media, loop) {
  switch (media.type) {
    case 'image':
    case 'gif': {
      const img = document.createElement('img');
      img.src = media.url;
      return img;
    }
    case 'video': {
      const video = document.createElement('video');
      video.dataset.src = media.url;   // src is set in setupVideoAudio (after the CORS check)
      video.autoplay  = true;
      video.loop      = false;  // looping is controlled manually in playVideoSegment
      video.muted     = false;
      video.playsInline = true;
      return video;
    }
    case 'youtube': {
      const iframe = document.createElement('iframe');
      const videoId = extractYoutubeId(media.url);
      iframe.src   = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1`;
      iframe.allow = 'autoplay';
      return iframe;
    }
    case 'tiktok': {
      const iframe = document.createElement('iframe');
      iframe.src       = media.url;
      iframe.allow     = 'autoplay; encrypted-media; picture-in-picture';
      iframe.className = 'embed-tiktok';
      return iframe;
    }
    case 'twitter': {
      const iframe = document.createElement('iframe');
      iframe.src       = media.url;
      iframe.allow     = 'autoplay; encrypted-media';
      iframe.className = 'embed-twitter';
      return iframe;
    }
    case 'emoji': {
      const div = document.createElement('div');
      div.className  = 'emoji-display';
      div.textContent = media.url;
      return div;
    }
    default: return null;
  }
}

// Play the segment [start, end] (seconds) of a video, repeated `times` times.
function playVideoSegment(video, start, end, times) {
  return new Promise((resolve) => {
    let plays = 0;
    let done  = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('ended', onEnded);
      resolve();
    };
    // Seek to `start` and play — wait for metadata if the video isn't ready yet.
    const restart = () => {
      const go = () => { try { video.currentTime = start; } catch {} video.play().catch(() => {}); };
      if (video.readyState >= 1) go();
      else video.addEventListener('loadedmetadata', go, { once: true });
    };
    const next = () => {
      plays++;
      if (plays >= times) { finish(); return; }
      restart();
    };
    const onTime  = () => { if (video.currentTime >= end) next(); };
    const onEnded = () => next();  // video shorter than the segment
    video.loop = false;
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('ended', onEnded);
    restart();
    const span = Math.max(1, end - start);
    setTimeout(finish, span * times * 1000 + 5000);  // safety ceiling
  });
}

function playAudio(audio) {
  return new Promise((resolve) => {
    const done = (a) => { if (a._anodes) { a._anodes.forEach(n => { try { n.disconnect(); } catch {} }); a._anodes = null; } a.src = ''; resolve(); };
    if (audio.type === 'sfx') {
      const name = audio.url.replace('sfx:', '');
      const a = new Audio(`sounds/${name}.mp3`);
      const sfxVol = (settings.volumeSfx || 80) / 100 * master();
      if (!normalizeChain(a, sfxVol)) a.volume = sfxVol;
      a.onended = () => done(a);
      a.onerror = () => done(a);
      a.play().catch(() => done(a));
      return;
    }
    if (audio.type === 'voice' && audio.url) {
      const a = new Audio(audio.url);
      a.volume  = Math.min(1, (settings.volumeVoice || 100) / 100 * master());
      a.onended = () => done(a);
      a.onerror = () => done(a);
      a.play().catch(() => done(a));
      return;
    }
    resolve();
  });
}

function waitForMedia(el) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(); };
    if (el.tagName === 'IMG') {
      if (el.complete && el.naturalWidth > 0) { resolve(); return; }
      el.addEventListener('load',  done, { once: true });
      el.addEventListener('error', done, { once: true });
    } else if (el.tagName === 'VIDEO') {
      el.addEventListener('canplay', done, { once: true });
      el.addEventListener('error',   done, { once: true });
    } else {
      resolve(); return;
    }
    setTimeout(done, 4000);
  });
}

function extractYoutubeId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([^&?/]+)/);
  return match ? match[1] : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

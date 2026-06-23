const container = document.getElementById('drop-container');
const badge     = document.getElementById('queue-badge');

let queue     = [];
let isPlaying = false;
let settings  = { positionX: 50, positionY: 50, duration: 5000, volumeSfx: 80, volumeVoice: 100 };

// Warm up the Web Speech voice list so Chromium has it ready before the first drop.
try { window.speechSynthesis.getVoices(); window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices(); } catch {}

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

  const hasFade = (event.effects || []).includes('fade');
  const hasSpin = (event.effects || []).includes('spin');

  let mediaEl = null;
  if (event.media) {
    mediaEl = buildMediaElement(event.media, event.loop);
    if (mediaEl) {
      if (hasSpin) mediaEl.classList.add('fx-spin');
      if (mediaEl.tagName === 'VIDEO' && mediaEl.dataset.src) await setupVideoAudio(mediaEl);
      container.appendChild(mediaEl);
      await waitForMedia(mediaEl);
      applySize(mediaEl, dropSize);   // normalize size once natural dims are known
    }
  }

  if (event.caption) {
    const cap = document.createElement('div');
    cap.className = 'drop-caption';
    cap.textContent = event.caption;
    container.appendChild(cap);
    speakCaption(event.caption);
  }

  applyPosition(dropX, dropY);

  // Fade in
  if (hasFade) {
    container.style.animation = 'fadeIn 3s ease forwards';
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
    // Play the whole embedded clip (best-effort fixed window)
    if (event.audio) playAudio(event.audio);
    await sleep(EMBED_FULL_MS);
  } else {
    // image / gif / emoji
    if (event.audio) playAudio(event.audio);
    await sleep(settings.duration || 5000);
  }

  // Fade out
  if (hasFade) {
    container.style.animation = 'fadeOut 3s ease forwards';
    await sleep(3000);
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

function speakCaption(text) {
  if (!text || !settings.ttsVoice) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const voice = window.speechSynthesis.getVoices().find(v => v.name === settings.ttsVoice);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.volume = Math.min(1, (settings.volumeVoice || 100) / 100 * master());
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
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
  const match = url.match(/(?:v=|youtu\.be\/)([^&?/]+)/);
  return match ? match[1] : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

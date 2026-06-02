const container = document.getElementById('drop-container');
const badge     = document.getElementById('queue-badge');

let queue     = [];
let isPlaying = false;
let settings  = { positionX: 50, positionY: 50, duration: 5000, volumeSfx: 80, volumeVoice: 100 };

// Width + height caps per size. Bigger sizes use viewport units so they
// scale with the screen — XL takes a big portion of the display.
const SIZE_MAP = {
  s:  { w: '220px', h: '200px' },
  m:  { w: '340px', h: '300px' },
  l:  { w: '560px', h: '460px' },
  xl: { w: '82vw',  h: '82vh'  },
};

window.memedrop.getSettings().then(s => { settings = s; applyPosition(); });
window.memedrop.onSettingsChanged(s => { settings = s; applyPosition(); });

window.memedrop.onDrop(event => {
  queue.push(event);
  updateBadge();
  if (!isPlaying) processQueue();
});

// Scale images/videos by the chosen size. Embeds (iframes) keep their fixed
// dimensions so small sizes don't distort TikTok/YouTube/Twitter players.
function applySize(mediaEl, size) {
  const sz = SIZE_MAP[size] || SIZE_MAP.m;
  if (mediaEl.tagName === 'IMG' || mediaEl.tagName === 'VIDEO') {
    container.style.maxWidth = sz.w;
    mediaEl.style.maxWidth   = '100%';
    mediaEl.style.maxHeight  = sz.h;
  }
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
      applySize(mediaEl, event.size);
      container.appendChild(mediaEl);
      await waitForMedia(mediaEl);
    }
  }

  if (event.caption) {
    const cap = document.createElement('div');
    cap.className = 'drop-caption';
    cap.textContent = event.caption;
    container.appendChild(cap);
  }

  applyPosition(event.positionX, event.positionY);

  // Fade in
  if (hasFade) {
    container.style.animation = 'fadeIn 3s ease forwards';
  }

  // Determine playback behavior
  const isVideo       = mediaEl && mediaEl.tagName === 'VIDEO';
  const isEmbed       = mediaEl && mediaEl.tagName === 'IFRAME';
  const VIDEO_CAP_MS  = 120000;  // play full video, but never hog the overlay past 2 min
  const EMBED_FULL_MS = 120000;  // embeds can't report their end — give them a long window

  if (event.loop === true) {
    // Loop the first N seconds a set number of times
    const segSecs = event.loopDuration || 10;
    const times   = Math.max(1, event.loopTimes || 1);
    if (event.audio) playAudio(event.audio);
    if (isVideo) {
      await playVideoSegment(mediaEl, segSecs, times);
    } else {
      // images / embeds can't be trimmed — just hold for the total time
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
  if (vid) { vid.pause(); vid.src = ''; }
  container.innerHTML       = '';
  await sleep(200);
  processQueue();
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
      video.src       = media.url;
      video.autoplay  = true;
      video.loop      = false;  // looping is controlled manually in playVideoSegment
      video.muted     = false;
      video.volume    = (settings.volumeSfx || 80) / 100;
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

// Play the first `segSecs` seconds of a video, repeated `times` times.
function playVideoSegment(video, segSecs, times) {
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
    const next = () => {
      plays++;
      if (plays >= times) { finish(); return; }
      try { video.currentTime = 0; video.play().catch(() => {}); } catch {}
    };
    const onTime  = () => { if (video.currentTime >= segSecs) next(); };
    const onEnded = () => next();  // video shorter than the segment
    video.loop = false;
    try { video.currentTime = 0; } catch {}
    video.play().catch(() => {});
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('ended', onEnded);
    setTimeout(finish, segSecs * times * 1000 + 5000);  // safety ceiling
  });
}

function playAudio(audio) {
  return new Promise((resolve) => {
    const done = (a) => { a.src = ''; resolve(); };
    if (audio.type === 'sfx') {
      const name = audio.url.replace('sfx:', '');
      const a = new Audio(`sounds/${name}.mp3`);
      a.volume  = (settings.volumeSfx || 80) / 100;
      a.onended = () => done(a);
      a.onerror = () => done(a);
      a.play().catch(() => done(a));
      return;
    }
    if (audio.type === 'voice' && audio.url) {
      const a = new Audio(audio.url);
      a.volume  = (settings.volumeVoice || 100) / 100;
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

// ── State ─────────────────────────────────────────────────────────────────────
let micDeviceId    = '';
const activeEffects = new Set();
let mediaRecorder  = null;
let recordedChunks = [];
let audioBlob      = null;
let recordingTimer = null;
let recordingSecs  = 0;
let mediaUrl       = null;
let mediaIsVideo   = false;
let trimScrubbable = false;   // true only for real playable videos (not embeds)
let videoDuration  = 0;
let trimStart      = 0;
let trimEnd        = 0;
let trimRepeat     = 1;
let trimDragging   = null;    // 'start' | 'end' | null
let previewStop    = null;
let selectedAnchor = 'center';
let selectedSize   = 'm';
let pendingSaveFav = null;
let tryhardMode    = false;

// Anchor → overlay positionX/positionY mapping
const ANCHOR_MAP = {
  'top-left':     { positionX: 15, positionY: 15 },
  'top-right':    { positionX: 85, positionY: 15 },
  'center':       { positionX: 50, positionY: 50 },
  'bottom-left':  { positionX: 15, positionY: 85 },
  'bottom-right': { positionX: 85, positionY: 85 },
};

// Tryhard mode forces medium size, top-right corner on every drop.
function effectiveDrop() {
  const anchor = tryhardMode ? 'top-right' : selectedAnchor;
  const size   = tryhardMode ? 'm' : selectedSize;
  const pos    = ANCHOR_MAP[anchor] || ANCHOR_MAP['center'];
  return { size, positionX: pos.positionX, positionY: pos.positionY };
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone    = document.getElementById('drop-zone');
const urlText     = document.getElementById('url-text');
const clearUrlBtn = document.getElementById('clear-url');
const urlPaste    = document.getElementById('url-paste');
const targetSel   = document.getElementById('target');
const refreshBtn  = document.getElementById('refresh-btn');
const capInput    = document.getElementById('caption');
const sendBtn     = document.getElementById('send-btn');
const statusEl    = document.getElementById('status');
const micBtn      = document.getElementById('mic-btn');
const voiceLabel  = document.getElementById('voice-label');
const dropView    = document.getElementById('drop-view');
const gifView     = document.getElementById('gif-view');
const trimRow      = document.getElementById('trim-row');
const trimEmpty    = document.getElementById('trim-empty');
const trimEditor   = document.getElementById('trim-editor');
const trimVideo    = document.getElementById('trim-video');
const trimTrack    = document.getElementById('trim-track');
const trimRange    = document.getElementById('trim-range');
const trimHStart   = document.getElementById('trim-h-start');
const trimHEnd     = document.getElementById('trim-h-end');
const trimPlayhead = document.getElementById('trim-playhead');
const trimReadout  = document.getElementById('trim-readout');
const trimRepVal   = document.getElementById('trim-rep-val');
const trimPreviewBtn = document.getElementById('trim-preview-btn');
const historyView  = document.getElementById('history-view');
const historyList  = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const libraryView  = document.getElementById('library-view');
const libraryGrid  = document.getElementById('library-grid');
const libraryEmpty = document.getElementById('library-empty');
const saveClipBtn  = document.getElementById('save-clip-btn');

// ── GIF slide panel ───────────────────────────────────────────────────────────
document.getElementById('open-gif-btn').addEventListener('click', openGifView);
document.getElementById('gif-back-btn').addEventListener('click', closeGifView);

function openGifView() {
  dropView.classList.add('slide-out');
  gifView.classList.add('slide-in');
  setTimeout(() => document.getElementById('gif-search-input').focus(), 300);
}

function closeGifView() {
  dropView.classList.remove('slide-out');
  gifView.classList.remove('slide-in');
}

// ── History slide panel ───────────────────────────────────────────────────────
document.getElementById('open-history-btn').addEventListener('click', openHistoryView);
document.getElementById('history-back-btn').addEventListener('click', closeHistoryView);

function openHistoryView() {
  dropView.classList.add('slide-out');
  historyView.classList.add('slide-in');
  loadHistory();
}

function closeHistoryView() {
  dropView.classList.remove('slide-out');
  historyView.classList.remove('slide-in');
}

async function loadHistory() {
  historyList.innerHTML = '';
  const entries = await window.sender.getHistory();
  if (!entries.length) {
    historyEmpty.style.display = 'block';
    return;
  }
  historyEmpty.style.display = 'none';
  entries.forEach(entry => historyList.appendChild(renderHistoryEntry(entry)));
}

function renderHistoryEntry(entry) {
  const el = document.createElement('div');
  el.className = 'history-entry';

  const thumb = document.createElement('div');
  thumb.className = 'history-thumb';
  const m = entry.media;
  if (m?.type === 'image' || m?.type === 'gif') {
    const img = document.createElement('img');
    img.src = m.url;
    img.onerror = () => { thumb.textContent = '🖼️'; };
    thumb.appendChild(img);
  } else if (m?.type === 'video')   { thumb.textContent = '🎬'; }
  else if (m?.type === 'youtube')   { thumb.textContent = '▶️'; }
  else if (m?.type === 'tiktok')    { thumb.textContent = '🎵'; }
  else if (m?.type === 'twitter')   { thumb.textContent = '🐦'; }
  else if (m?.type === 'emoji')     { thumb.textContent = m.url; }
  else                              { thumb.textContent = '🎤'; }

  const info = document.createElement('div');
  info.className = 'history-info';
  const cap = document.createElement('div');
  cap.className = entry.caption ? 'history-caption' : 'history-caption no-caption';
  cap.textContent = entry.caption || (m ? m.type : 'audio only');
  const time = document.createElement('div');
  time.className = 'history-time';
  time.textContent = relativeTime(entry.timestamp);
  info.appendChild(cap);
  info.appendChild(time);

  const btn = document.createElement('button');
  btn.className = 'history-resend';
  btn.textContent = '↩ Re-send';
  btn.addEventListener('click', () => resendHistoryEntry(entry, btn));

  el.appendChild(thumb);
  el.appendChild(info);
  el.appendChild(btn);
  return el;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)    return 'just now';
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

async function resendHistoryEntry(entry, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const drop = tryhardMode ? effectiveDrop() : {
      size:      entry.size      || 'm',
      positionX: entry.positionX ?? null,
      positionY: entry.positionY ?? null,
    };
    const result = await window.sender.sendDrop({
      url:          entry.media?.url || null,
      target:       null,
      caption:      entry.caption,
      effects:      entry.effects      || [],
      audioUrl:     null,
      loop:         entry.loop         || false,
      loopDuration: entry.loopDuration || null,
      loopTimes:    entry.loopTimes    || null,
      trimStart:    entry.trimStart    ?? null,
      trimEnd:      entry.trimEnd      ?? null,
      size:         drop.size,
      positionX:    drop.positionX,
      positionY:    drop.positionY,
    });
    btn.textContent = result.ok ? '✓' : '✗';
    setTimeout(() => { btn.disabled = false; btn.textContent = '↩ Re-send'; }, 1500);
  } catch {
    btn.disabled = false;
    btn.textContent = '↩ Re-send';
  }
}

document.getElementById('history-clear-btn').addEventListener('click', async () => {
  await window.sender.clearHistory();
  historyList.innerHTML = '';
  historyEmpty.style.display = 'block';
});

// ── Init ──────────────────────────────────────────────────────────────────────
window.sender.getSettings().then(s => {
  micDeviceId = s.micDeviceId || '';
  tryhardMode = !!s.tryhardMode;
  const savedAnchor = s.anchorPosition || 'center';
  setAnchor(savedAnchor, false);
  const savedSize = s.dropSize || 'm';
  setSize(savedSize, false);
});
loadUsers();

// ── Users dropdown ────────────────────────────────────────────────────────────
async function loadUsers() {
  refreshBtn.classList.add('spinning');
  try {
    const result = await window.sender.getUsers();
    while (targetSel.options.length > 1) targetSel.remove(1);
    (result.users || []).forEach(u => {
      const opt = document.createElement('option');
      opt.value = u; opt.textContent = `@${u}`;
      targetSel.appendChild(opt);
    });
  } catch(e) {}
  setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
}
refreshBtn.addEventListener('click', loadUsers);

// ── Anchor grid ───────────────────────────────────────────────────────────────
document.querySelectorAll('.anchor-btn').forEach(btn => {
  btn.addEventListener('click', () => setAnchor(btn.dataset.anchor, true));
});

function setAnchor(anchor, persist) {
  selectedAnchor = anchor;
  document.querySelectorAll('.anchor-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.anchor === anchor);
  });
  if (persist) {
    const pos = ANCHOR_MAP[anchor] || ANCHOR_MAP['center'];
    window.sender.saveSettings({ anchorPosition: anchor, positionX: pos.positionX, positionY: pos.positionY });
  }
}

// ── Size chips ────────────────────────────────────────────────────────────────
document.querySelectorAll('.size-chip').forEach(btn => {
  btn.addEventListener('click', () => setSize(btn.dataset.size, true));
});

function setSize(size, persist) {
  selectedSize = size;
  document.querySelectorAll('.size-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.size === size);
  });
  if (persist) {
    window.sender.saveSettings({ dropSize: size });
  }
}

// ── Trim timeline ───────────────────────────────────────────────────────────
function fmtClock(s) {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// Enable the trim card for a real playable video; show a hint otherwise.
function setTrimEnabled(scrubbable, url) {
  stopPreview();
  trimScrubbable = false;
  videoDuration = 0; trimStart = 0; trimEnd = 0;
  setRepeat(1);
  if (scrubbable && url) {
    trimRow.classList.remove('disabled');
    trimEmpty.style.display = 'none';
    trimEditor.style.display = 'block';
    trimReadout.textContent = 'loading…';
    trimVideo.src = url;
  } else {
    trimRow.classList.add('disabled');
    trimEditor.style.display = 'none';
    trimEmpty.style.display = 'block';
    trimEmpty.textContent = url ? "can't trim embeds — plays full" : 'load a video to trim';
    try { trimVideo.removeAttribute('src'); trimVideo.load(); } catch {}
  }
}

trimVideo.addEventListener('loadedmetadata', () => {
  videoDuration = trimVideo.duration || 0;
  if (!isFinite(videoDuration) || videoDuration <= 0) { trimPreviewUnavailable(); return; }
  trimScrubbable = true;
  trimStart = 0; trimEnd = videoDuration;
  renderTrim();
});
trimVideo.addEventListener('error', trimPreviewUnavailable);

function trimPreviewUnavailable() {
  trimScrubbable = false; videoDuration = 0;
  trimEditor.style.display = 'none';
  trimEmpty.style.display = 'block';
  trimEmpty.textContent = 'preview unavailable — plays full';
}

function renderTrim() {
  const a = videoDuration ? (trimStart / videoDuration) * 100 : 0;
  const b = videoDuration ? (trimEnd   / videoDuration) * 100 : 100;
  trimRange.style.left  = a + '%';
  trimRange.style.width = (b - a) + '%';
  trimHStart.style.left = a + '%';
  trimHEnd.style.left   = b + '%';
  const dur = Math.max(0, trimEnd - trimStart);
  trimReadout.textContent = `${fmtClock(trimStart)} → ${fmtClock(trimEnd)} · ${dur.toFixed(1)}s`;
}

function trackToTime(clientX) {
  const r = trimTrack.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return ratio * videoDuration;
}

function startDrag(which, e) {
  if (!trimScrubbable || !videoDuration) return;
  trimDragging = which;
  stopPreview();
  trimVideo.pause();
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', endDrag, { once: true });
  e.preventDefault();
}
function onDragMove(e) {
  if (!trimDragging) return;
  const t = trackToTime(e.clientX);
  if (trimDragging === 'start') {
    trimStart = Math.max(0, Math.min(t, trimEnd - 0.1));
    try { trimVideo.currentTime = trimStart; } catch {}
  } else {
    trimEnd = Math.min(videoDuration, Math.max(t, trimStart + 0.1));
    try { trimVideo.currentTime = trimEnd; } catch {}
  }
  renderTrim();
}
function endDrag() {
  trimDragging = null;
  window.removeEventListener('pointermove', onDragMove);
}
trimHStart.addEventListener('pointerdown', (e) => startDrag('start', e));
trimHEnd.addEventListener('pointerdown', (e) => startDrag('end', e));

// ── Preview the selected segment ──
trimPreviewBtn.addEventListener('click', previewSegment);
function previewSegment() {
  if (!trimScrubbable || !videoDuration) return;
  if (previewStop) { stopPreview(); return; }
  trimPlayhead.style.display = 'block';
  try { trimVideo.currentTime = trimStart; } catch {}
  trimVideo.play().catch(() => {});
  trimPreviewBtn.textContent = '⏸ Stop';
  const onTime = () => {
    const pct = videoDuration ? (trimVideo.currentTime / videoDuration) * 100 : 0;
    trimPlayhead.style.left = pct + '%';
    if (trimVideo.currentTime >= trimEnd) stopPreview();
  };
  previewStop = () => trimVideo.removeEventListener('timeupdate', onTime);
  trimVideo.addEventListener('timeupdate', onTime);
}
function stopPreview() {
  if (previewStop) { previewStop(); previewStop = null; }
  try { trimVideo.pause(); } catch {}
  trimPlayhead.style.display = 'none';
  trimPreviewBtn.textContent = '▶ Preview';
}

// ── Repeat (× N) ──
function setRepeat(n) {
  trimRepeat = Math.min(10, Math.max(1, n));
  trimRepVal.textContent = trimRepeat + '×';
}
document.getElementById('trim-rep-dn').addEventListener('click', () => setRepeat(trimRepeat - 1));
document.getElementById('trim-rep-up').addEventListener('click', () => setRepeat(trimRepeat + 1));

// ── Drag and drop ─────────────────────────────────────────────────────────────
let dragCounter = 0;
dropView.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropZone.classList.add('drag-over'); urlText.textContent = 'Release to upload…'; });
dropView.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropZone.classList.remove('drag-over'); if (!mediaUrl) urlText.textContent = 'Drop a file here, or paste a URL below'; } });
dropView.addEventListener('dragover', (e) => e.preventDefault());
dropView.addEventListener('drop', async (e) => {
  e.preventDefault(); dragCounter = 0; dropZone.classList.remove('drag-over');
  const file = [...(e.dataTransfer?.files || [])][0];
  if (!file) return;
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { setStatus('Only images and videos', 'err'); return; }
  await uploadFile(file);
});

async function uploadFile(file) {
  setStatus('Uploading…');
  try {
    const ab = await file.arrayBuffer();
    const r  = await window.sender.uploadMedia(ab, file.type);
    if (r.error) throw new Error(r.error);
    const isVid = file.type.startsWith('video/');
    setMediaUrl(r.url, file.name, isVid);
    setStatus('✓ Ready', 'ok');
    setTimeout(() => setStatus(''), 1200);
  } catch(err) {
    setStatus('Upload failed: ' + err.message, 'err');
    clearMedia();
  }
}

function isEmbedUrl(u) {
  return /tiktok\.com|(?:twitter\.com|x\.com)|youtube\.com|youtu\.be/.test(u || '');
}

// opts: { scrubbable, previewUrl }
//   url       — what actually gets sent (original link for TikTok/Twitter, so the
//               server re-resolves a fresh CDN url at drop time)
//   previewUrl — the direct, seekable mp4 to load into the trim timeline
function setMediaUrl(url, label, isVideo = false, opts = {}) {
  mediaUrl = url; mediaIsVideo = isVideo; urlPaste.value = '';
  dropZone.classList.add('has-url');
  urlText.textContent = label || url;
  clearUrlBtn.style.display = 'block';
  saveClipBtn.style.display = isVideo ? 'block' : 'none';
  const scrubbable = opts.scrubbable ?? (isVideo && !isEmbedUrl(url));
  const previewUrl = scrubbable ? (opts.previewUrl || url) : (isVideo ? url : null);
  setTrimEnabled(scrubbable, previewUrl);
}

function clearMedia() {
  mediaUrl = null; mediaIsVideo = false;
  dropZone.classList.remove('has-url');
  urlText.textContent = 'Drop a file here, or paste a URL below';
  clearUrlBtn.style.display = 'none';
  saveClipBtn.style.display = 'none';
  setTrimEnabled(false, null);
}
clearUrlBtn.addEventListener('click', clearMedia);

urlPaste.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { await applyPastedUrl(); send(); } });
urlPaste.addEventListener('blur', () => applyPastedUrl());
async function applyPastedUrl() {
  const v = urlPaste.value.trim();
  if (!v.startsWith('http')) return;

  // TikTok / Twitter resolve to a direct, seekable mp4 → trimmable via playback.
  // We keep the ORIGINAL link as mediaUrl so the server re-resolves a fresh CDN
  // url at drop time, and use the resolved mp4 only for the scrub preview.
  const isTikTok  = /tiktok\.com\/@[\w.]+\/video\/\d+/.test(v);
  const isTwitter = /(?:twitter\.com|x\.com)\/\w+\/status\/\d+/.test(v);
  if (isTikTok || isTwitter) {
    const label = isTikTok ? '🎵 TikTok video' : '🐦 Twitter / X video';
    setStatus('Resolving…');
    try {
      const r = await window.sender.resolveLink(v);
      if (r && r.type === 'video' && r.url) {
        setMediaUrl(v, label, true, { scrubbable: true, previewUrl: r.url });
        setStatus('✓ ready to trim', 'ok');
        setTimeout(() => setStatus(''), 1200);
      } else {
        setMediaUrl(v, label, true, { scrubbable: false });
        setStatus("couldn't trim this one — plays full");
        setTimeout(() => setStatus(''), 2000);
      }
    } catch {
      setMediaUrl(v, label, true, { scrubbable: false });
      setStatus('');
    }
    return;
  }

  // YouTube stays a full-play embed for now (no direct url to scrub).
  if (/(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/.test(v)) {
    setMediaUrl(v, '▶️ YouTube video', true, { scrubbable: false }); return;
  }

  const ext = v.split('.').pop().split('?')[0].toLowerCase();
  const isVid = ['mp4', 'webm'].includes(ext);
  setMediaUrl(v, v, isVid);
}

// ── Effects ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const fx = chip.dataset.fx;
    if (activeEffects.has(fx)) { activeEffects.delete(fx); chip.classList.remove('active'); }
    else { activeEffects.add(fx); chip.classList.add('active'); }
  });
});

// ── Close / Escape ────────────────────────────────────────────────────────────
document.getElementById('close-btn').addEventListener('click', () => window.sender.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.getElementById('lib-modal').classList.contains('open')) { closeLibModal(); }
    else if (gifView.classList.contains('slide-in')) closeGifView();
    else if (historyView.classList.contains('slide-in')) closeHistoryView();
    else if (libraryView.classList.contains('slide-in')) closeLibraryView();
    else window.sender.close();
  }
});
capInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// ── Microphone ────────────────────────────────────────────────────────────────
micBtn.addEventListener('click', toggleRecording);
async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
  try {
    const audioConstraints = micDeviceId ? { deviceId: { exact: micDeviceId } } : true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    recordedChunks = []; audioBlob = null;
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
      stopTimer();
      micBtn.className = 'has-audio';
      micBtn.innerHTML = `🎤 ✓ ${formatTime(recordingSecs)}`;
      voiceLabel.textContent = `${formatTime(recordingSecs)} recorded — click to re-record`;
      voiceLabel.className = 'active';
    };
    mediaRecorder.start(); startTimer();
    micBtn.className = 'recording'; micBtn.innerHTML = `⏹ ${formatTime(recordingSecs)}`;
    voiceLabel.textContent = 'Recording… click to stop'; voiceLabel.className = '';
  } catch(err) { setStatus('Mic access denied', 'err'); }
}
function startTimer() { recordingSecs = 0; recordingTimer = setInterval(() => { recordingSecs++; micBtn.innerHTML = `⏹ ${formatTime(recordingSecs)}`; }, 1000); }
function stopTimer()  { clearInterval(recordingTimer); recordingTimer = null; }
function formatTime(s) { return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }

// ── Send ──────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', send);

async function send() {
  await applyPastedUrl();
  const url          = mediaUrl || null;
  const target       = targetSel.value || null;
  const caption      = capInput.value.trim() || null;
  const effects      = [...activeEffects];

  // Trim: send a segment when the user moved a handle OR wants it repeated.
  const wantRepeat  = trimScrubbable && trimRepeat > 1;
  const useTrim     = trimScrubbable && videoDuration > 0 &&
                      (trimStart > 0.05 || trimEnd < videoDuration - 0.05 || wantRepeat);
  const trimStartVal = useTrim ? +Math.max(0, trimStart).toFixed(2) : null;
  const trimEndVal   = useTrim ? +Math.min(videoDuration, trimEnd).toFixed(2) : null;
  const loopTimesVal = useTrim ? trimRepeat : null;

  if (!url && !audioBlob) { setStatus('Add a URL, drop a file, or record audio', 'err'); return; }

  sendBtn.disabled = true;
  try {
    let audioUrl = null;
    if (audioBlob) {
      setStatus('Uploading audio…');
      const r = await window.sender.uploadAudio(await audioBlob.arrayBuffer());
      if (r.error) throw new Error(r.error);
      audioUrl = r.url;
    }
    setStatus('Sending…');
    const drop = effectiveDrop();
    const result = await window.sender.sendDrop({
      url, target, caption, effects, audioUrl,
      loop: false,
      loopDuration: null,
      loopTimes: loopTimesVal,
      trimStart: trimStartVal,
      trimEnd: trimEndVal,
      size: drop.size,
      positionX: drop.positionX,
      positionY: drop.positionY,
    });
    if (result.ok) {
      setStatus('✓ Dropped!', 'ok');
      let mediaType = null;
      if (url) {
        if (/tiktok\.com/.test(url))              mediaType = 'tiktok';
        else if (/(?:twitter|x)\.com/.test(url))  mediaType = 'twitter';
        else if (/(?:youtube\.com|youtu\.be)/.test(url)) mediaType = 'youtube';
        else if (mediaIsVideo)                    mediaType = 'video';
        else                                      mediaType = 'image';
      }
      window.sender.saveHistory({
        id:           Date.now(),
        timestamp:    Date.now(),
        media:        url ? { type: mediaType, url } : null,
        caption,
        size:         drop.size,
        positionX:    drop.positionX,
        positionY:    drop.positionY,
        effects,
        loop:         false,
        loopDuration: null,
        loopTimes:    loopTimesVal,
        trimStart:    trimStartVal,
        trimEnd:      trimEndVal,
        target:       target || null,
      });
      resetForm();
    } else {
      setStatus(result.error || 'Server error', 'err');
    }
  } catch(err) {
    setStatus('Error: ' + err.message, 'err');
  } finally {
    sendBtn.disabled = false;
  }
}

// ── GIF Search ────────────────────────────────────────────────────────────────
let searchTimeout    = null;
const gifSearchInput = document.getElementById('gif-search-input');
const gifGrid        = document.getElementById('gif-grid');
const gifStatus      = document.getElementById('gif-status');

gifSearchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const q = gifSearchInput.value.trim();
  if (!q) { gifGrid.innerHTML = ''; gifStatus.textContent = 'Type something to search'; gifStatus.style.display = 'block'; return; }
  gifStatus.textContent = 'Searching…'; gifStatus.style.display = 'block'; gifGrid.innerHTML = '';
  searchTimeout = setTimeout(() => searchGifs(q), 400);
});

async function searchGifs(query) {
  const result = await window.sender.searchGifs(query);
  gifGrid.innerHTML = '';

  if (result.error === 'no_key') {
    gifStatus.textContent = '⚠️ Add your Giphy API key in Settings first';
    gifStatus.style.display = 'block'; return;
  }
  if (result.error) {
    gifStatus.textContent = '❌ ' + result.error;
    gifStatus.style.display = 'block'; return;
  }

  const items = result.data || [];
  if (!items.length) { gifStatus.textContent = 'No results'; gifStatus.style.display = 'block'; return; }

  gifStatus.style.display = 'none';
  items.forEach(item => {
    const mp4Url  = item.images?.original?.mp4 || '';
    const preview = item.images?.fixed_width?.url || item.images?.downsized?.url || '';
    if (!mp4Url && !preview) return;

    const div = document.createElement('div');
    div.className = 'gif-item';
    const img = document.createElement('img');
    img.src = preview || mp4Url;
    img.loading = 'lazy';
    div.appendChild(img);
    div.addEventListener('click', () => {
      setMediaUrl(mp4Url || preview, item.title || 'GIF', !!mp4Url);
      closeGifView();
      setStatus('✓ GIF selected', 'ok');
      setTimeout(() => setStatus(''), 1200);
    });
    gifGrid.appendChild(div);
  });
}

// ── Save favorite ─────────────────────────────────────────────────────────────
document.getElementById('fav-save-ok').addEventListener('click', async () => {
  const name = document.getElementById('fav-name-input').value.trim();
  if (!name || !pendingSaveFav) return;
  await window.sender.saveFavorite({ ...pendingSaveFav, name });
  document.getElementById('fav-modal').classList.remove('open');
  pendingSaveFav = null;
  setStatus('⭐ Saved!', 'ok');
  setTimeout(() => setStatus(''), 1500);
});

document.getElementById('fav-save-cancel').addEventListener('click', () => {
  document.getElementById('fav-modal').classList.remove('open');
  pendingSaveFav = null;
});

document.getElementById('fav-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  document.getElementById('fav-save-ok').click();
  if (e.key === 'Escape') document.getElementById('fav-save-cancel').click();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, cls = '') { statusEl.textContent = msg; statusEl.className = cls; }

function resetForm() {
  clearMedia(); urlPaste.value = ''; capInput.value = '';
  targetSel.value = '';
  activeEffects.clear();
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  audioBlob = null; recordedChunks = []; stopTimer();
  micBtn.className = ''; micBtn.innerHTML = '🎤 Record';
  voiceLabel.textContent = 'No recording'; voiceLabel.className = '';
}

// ── Clip library ──────────────────────────────────────────────────────────────
const SITUATIONS = [
  { id: 'w',          label: '🏆 W / Flex' },
  { id: 'cooked',     label: '💀 Cooked' },
  { id: 'clown',      label: '🤡 Clown' },
  { id: 'aura',       label: '🥶 Aura' },
  { id: 'disrespect', label: '😤 Disrespect' },
  { id: 'copium',     label: '😭 Copium' },
  { id: 'hype',       label: '🔥 Hype' },
  { id: 'sus',        label: '👀 Sus' },
];
const SIT_LABEL = Object.fromEntries(SITUATIONS.map(s => [s.id, s.label]));
let activeSituation = 'all';
let pickedSituation = 'w';
let libraryCache = [];

document.getElementById('open-library-btn').addEventListener('click', openLibraryView);
document.getElementById('library-back-btn').addEventListener('click', closeLibraryView);

async function openLibraryView() {
  buildSituationFilter();
  dropView.classList.add('slide-out');
  libraryView.classList.add('slide-in');
  await renderLibrary();
}
function closeLibraryView() {
  dropView.classList.remove('slide-out');
  libraryView.classList.remove('slide-in');
}

function buildSituationFilter() {
  const wrap = document.getElementById('situation-filter');
  wrap.innerHTML = '';
  const all = ['all', ...SITUATIONS.map(s => s.id)];
  all.forEach(id => {
    const chip = document.createElement('div');
    chip.className = 'sit-chip' + (id === activeSituation ? ' active' : '');
    chip.textContent = id === 'all' ? '✨ All' : SIT_LABEL[id];
    chip.addEventListener('click', () => {
      activeSituation = id;
      buildSituationFilter();
      renderLibrary();
    });
    wrap.appendChild(chip);
  });
}

async function renderLibrary() {
  libraryCache = await window.sender.libraryList();
  const items = libraryCache.filter(c => activeSituation === 'all' || c.situation === activeSituation);
  libraryGrid.innerHTML = '';
  if (!items.length) {
    libraryEmpty.style.display = 'block';
    libraryEmpty.textContent = libraryCache.length
      ? 'No clips in this situation yet'
      : 'No clips saved yet — paste a video and hit ★ Save';
    return;
  }
  libraryEmpty.style.display = 'none';
  items.forEach(entry => {
    const tile = document.createElement('div');
    tile.className = 'clip-tile';

    const vid = document.createElement('video');
    vid.src = `clip://clips/${entry.file}`;
    vid.muted = true; vid.preload = 'metadata'; vid.playsInline = true;
    tile.addEventListener('mouseenter', () => { vid.play().catch(() => {}); });
    tile.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = 0; });

    const name = document.createElement('div');
    name.className = 'clip-name';
    name.textContent = entry.name;

    const del = document.createElement('button');
    del.className = 'clip-del'; del.textContent = '✕';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      libraryCache = await window.sender.libraryDelete(entry.id);
      renderLibrary();
    });

    tile.addEventListener('click', () => loadLibraryClip(entry, tile));
    tile.appendChild(vid); tile.appendChild(del); tile.appendChild(name);
    libraryGrid.appendChild(tile);
  });
}

// Clicking a library clip loads its media into the main drop view so you can
// add a caption, pick size/position, etc. before sending — it no longer sends instantly.
async function loadLibraryClip(entry, tile) {
  const busy = document.createElement('div');
  busy.className = 'clip-sending'; busy.textContent = 'Loading…';
  tile.appendChild(busy);
  try {
    const up = await window.sender.libraryUpload(entry.id);
    if (up.error || !up.url) throw new Error(up.error || 'upload failed');
    setMediaUrl(up.url, entry.name, true);
    busy.remove();
    closeLibraryView();
    capInput.focus();
    setStatus('✓ Loaded — add a caption & send', 'ok');
    setTimeout(() => setStatus(''), 2000);
  } catch (err) {
    busy.textContent = '✗ ' + err.message;
    setTimeout(() => busy.remove(), 1500);
  }
}

// ── Save-to-library modal ──
saveClipBtn.addEventListener('click', openLibModal);

function openLibModal() {
  if (!mediaUrl) return;
  pickedSituation = 'w';
  const nameInput = document.getElementById('lib-name-input');
  nameInput.value = (capInput.value.trim() || '').slice(0, 60);
  buildSituationPicker();
  document.getElementById('lib-modal').classList.add('open');
  setTimeout(() => nameInput.focus(), 50);
}
function closeLibModal() {
  document.getElementById('lib-modal').classList.remove('open');
}

function buildSituationPicker() {
  const wrap = document.getElementById('lib-situation-pick');
  wrap.innerHTML = '';
  SITUATIONS.forEach(s => {
    const chip = document.createElement('div');
    chip.className = 'sit-chip' + (s.id === pickedSituation ? ' active' : '');
    chip.textContent = s.label;
    chip.addEventListener('click', () => { pickedSituation = s.id; buildSituationPicker(); });
    wrap.appendChild(chip);
  });
}

document.getElementById('lib-save-ok').addEventListener('click', async () => {
  if (!mediaUrl) return;
  const okBtn = document.getElementById('lib-save-ok');
  const name = document.getElementById('lib-name-input').value.trim() || 'Clip';
  okBtn.disabled = true; okBtn.textContent = 'Saving…';
  const res = await window.sender.librarySave({ url: mediaUrl, name, situation: pickedSituation });
  okBtn.disabled = false; okBtn.textContent = 'Save';
  if (res.error) { setStatus('✗ ' + res.error, 'err'); setTimeout(() => setStatus(''), 2500); return; }
  closeLibModal();
  setStatus('📚 Saved to library!', 'ok');
  setTimeout(() => setStatus(''), 1500);
  if (libraryView.classList.contains('slide-in')) renderLibrary();
});

document.getElementById('lib-save-cancel').addEventListener('click', closeLibModal);
document.getElementById('lib-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('lib-save-ok').click();
});

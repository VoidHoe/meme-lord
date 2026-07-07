// ── State ─────────────────────────────────────────────────────────────────────
const activeEffects = new Set();
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

// Anchor → overlay positionX/positionY mapping
const ANCHOR_MAP = {
  'top-left':     { positionX: 15, positionY: 15 },
  'top-right':    { positionX: 85, positionY: 15 },
  'center':       { positionX: 50, positionY: 50 },
  'bottom-left':  { positionX: 15, positionY: 85 },
  'bottom-right': { positionX: 85, positionY: 85 },
};

function effectiveDrop() {
  const pos = ANCHOR_MAP[selectedAnchor] || ANCHOR_MAP['center'];
  return { size: selectedSize, positionX: pos.positionX, positionY: pos.positionY };
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const composePanel = document.getElementById('compose-panel');
const dropZone    = document.getElementById('drop-zone');
const stageMedia  = document.getElementById('stage-media');
const stagePrompt = document.getElementById('stage-prompt');
const urlText     = document.getElementById('url-text');
const clearUrlBtn = document.getElementById('clear-url');
const urlPaste    = document.getElementById('url-paste');
const targetSel   = document.getElementById('target');
const refreshBtn  = document.getElementById('refresh-btn');
const capInput    = document.getElementById('caption');
const capBottomInput = document.getElementById('caption-bottom');
const sendBtn     = document.getElementById('send-btn');
const statusEl    = document.getElementById('status');
const advanced    = document.getElementById('advanced');
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
const historyList  = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const libraryGrid  = document.getElementById('library-grid');
const libraryEmpty = document.getElementById('library-empty');
const saveClipBtn  = document.getElementById('save-clip-btn');

// ── Tabs ────────────────────────────────────────────────────────────────────
const tabBtns = [...document.querySelectorAll('.tab')];
const PANELS = { compose: 'compose-panel', deck: 'deck-panel', library: 'library-panel', gif: 'gif-panel', history: 'history-panel', settings: 'settings-panel' };

function isPanelActive(name) {
  return document.getElementById(PANELS[name]).classList.contains('active');
}

function showTab(name) {
  if (!PANELS[name]) return;
  tabBtns.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  Object.entries(PANELS).forEach(([k, id]) => document.getElementById(id).classList.toggle('active', k === name));
  if (name === 'deck')     renderDeck();
  if (name === 'library')  renderLibrary();
  if (name === 'history')  loadHistory();
  if (name === 'gif')      setTimeout(() => gifSearchInput.focus(), 60);
  if (name === 'settings') loadSettingsForm();
}
tabBtns.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
if (window.sender.onShowTab) window.sender.onShowTab(tab => showTab(tab));

// A snip arrived from the region selector (Phase 2 global hotkey) → load it.
if (window.sender.onSnipResult) {
  window.sender.onSnipResult((d) => {
    showTab('compose');
    if (d && d.url) {
      setMediaUrl(d.url, '📸 Snip', false);
      setStatus('✓ Snip ready — caption & send', 'ok');
      setTimeout(() => setStatus(''), 1800);
    } else {
      setStatus('Snip failed: ' + ((d && d.error) || 'unknown'), 'err');
    }
  });
}

// ── Window controls ───────────────────────────────────────────────────────────
document.getElementById('close-btn').addEventListener('click', () => window.sender.close());
document.getElementById('min-btn').addEventListener('click', () => window.sender.minimize());

// ── Snip button (opens Windows region snip → user pastes the result) ───────────
document.getElementById('snip-btn').addEventListener('click', async () => {
  setStatus('Opening Snip — draw a box, then Ctrl+V here ↩');
  try { await window.sender.openSnipTool(); } catch {}
});

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  historyList.innerHTML = '';
  const entries = await window.sender.getHistory();
  if (!entries.length) { historyEmpty.style.display = 'block'; return; }
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
    const drop = {
      size:      entry.size      || 'm',
      positionX: entry.positionX ?? null,
      positionY: entry.positionY ?? null,
    };
    const result = await window.sender.sendDrop({
      url:          entry.media?.url || null,
      target:       null,
      caption:      entry.caption,
      captionTop:   entry.captionTop    ?? null,
      captionBottom: entry.captionBottom ?? null,
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
  setAnchor(s.anchorPosition || 'center', false);
  setSize(s.dropSize || 'm', false);
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
  document.querySelectorAll('.anchor-btn').forEach(b => b.classList.toggle('active', b.dataset.anchor === anchor));
  if (persist) {
    const pos = ANCHOR_MAP[anchor] || ANCHOR_MAP['center'];
    window.sender.saveSettings({ anchorPosition: anchor, positionX: pos.positionX, positionY: pos.positionY });
  }
}

// ── Size chips ────────────────────────────────────────────────────────────────
document.querySelectorAll('.size-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    setSize(btn.dataset.size, true);
  });
});
function setSize(size, persist) {
  selectedSize = size;
  document.querySelectorAll('.size-chip').forEach(b => b.classList.toggle('active', b.dataset.size === size));
  if (persist) window.sender.saveSettings({ dropSize: size });
}

// ── Trim timeline ───────────────────────────────────────────────────────────
function fmtClock(s) {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

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

function setRepeat(n) {
  trimRepeat = Math.min(10, Math.max(1, n));
  trimRepVal.textContent = trimRepeat + '×';
}
document.getElementById('trim-rep-dn').addEventListener('click', () => setRepeat(trimRepeat - 1));
document.getElementById('trim-rep-up').addEventListener('click', () => setRepeat(trimRepeat + 1));

// ── Drag and drop (onto the Compose panel) ──────────────────────────────────────
let dragCounter = 0;
composePanel.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropZone.classList.add('drag-over'); if (!mediaUrl) urlText.textContent = 'Release to upload…'; });
composePanel.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropZone.classList.remove('drag-over'); if (!mediaUrl) urlText.textContent = 'Paste or drop your meme'; } });
composePanel.addEventListener('dragover', (e) => e.preventDefault());
composePanel.addEventListener('drop', async (e) => {
  e.preventDefault(); dragCounter = 0; dropZone.classList.remove('drag-over');
  const file = [...(e.dataTransfer?.files || [])][0];
  if (!file) return;
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { setStatus('Only images and videos', 'err'); return; }
  await uploadFile(file);
});

// ── Paste a screenshot / image straight into Compose ────────────────────────────
document.addEventListener('paste', async (e) => {
  // On the Library tab, paste a link (or video) to save it instantly — unless the
  // caret is in a field (e.g. the search box), where paste should behave normally.
  if (isPanelActive('library')) {
    const tag = e.target?.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const vidItem = [...(e.clipboardData?.items || [])].find(it => it.type.startsWith('video/'));
    const text = (e.clipboardData?.getData('text') || '').trim();
    if (vidItem) { e.preventDefault(); const f = vidItem.getAsFile(); if (f) await saveFileToLibrary(f); return; }
    if (text.startsWith('http')) { e.preventDefault(); await saveLinkToLibrary(text); return; }
    return;
  }

  const items = [...(e.clipboardData?.items || [])];
  const imgItem = items.find(it => it.type.startsWith('image/'));
  if (!imgItem) return;   // not an image — let text paste (caption/link) proceed
  e.preventDefault();
  const file = imgItem.getAsFile();
  if (!file) return;
  showTab('compose');
  await uploadFile(file, 'Pasted image');
});

async function uploadFile(file, label) {
  setStatus('Uploading…');
  try {
    const ab = await file.arrayBuffer();
    const r  = await window.sender.uploadMedia(ab, file.type || 'image/png');
    if (r.error) throw new Error(r.error);
    const isVid = (file.type || '').startsWith('video/');
    setMediaUrl(r.url, label || file.name || 'Pasted image', isVid);
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

// Render a preview of the loaded media inside the stage.
function renderStagePreview(url, label, isVideo) {
  stagePrompt.style.display = 'none';
  stageMedia.style.display = 'flex';
  stageMedia.innerHTML = '';
  const fallback = (ic) => { stageMedia.innerHTML = `<div style="text-align:center"><div class="embed-ic">${ic}</div><span class="embed-label">${label || ''}</span></div>`; };
  if (isEmbedUrl(url)) {
    const ic = /tiktok\.com/.test(url) ? '🎵' : /(?:twitter\.com|x\.com)/.test(url) ? '🐦' : '▶️';
    fallback(ic);
  } else if (isVideo) {
    const v = document.createElement('video');
    v.src = url; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.onerror = () => fallback('🎬');
    stageMedia.appendChild(v);
    v.play().catch(() => {});
  } else {
    const img = document.createElement('img');
    img.src = url; img.onerror = () => fallback('🖼️');
    stageMedia.appendChild(img);
  }
}

// opts: { scrubbable, previewUrl }
function setMediaUrl(url, label, isVideo = false, opts = {}) {
  mediaUrl = url; mediaIsVideo = isVideo; urlPaste.value = '';
  dropZone.classList.add('has-media');
  urlText.textContent = label || url;
  clearUrlBtn.style.display = 'block';
  saveClipBtn.style.display = isVideo ? 'block' : 'none';
  renderStagePreview(url, label, isVideo);
  const scrubbable = opts.scrubbable ?? (isVideo && !isEmbedUrl(url));
  const previewUrl = scrubbable ? (opts.previewUrl || url) : (isVideo ? url : null);
  setTrimEnabled(scrubbable, previewUrl);
  if (scrubbable) advanced.open = true;
}

function clearMedia() {
  mediaUrl = null; mediaIsVideo = false;
  dropZone.classList.remove('has-media');
  stageMedia.style.display = 'none'; stageMedia.innerHTML = '';
  stagePrompt.style.display = '';
  urlText.textContent = 'Paste or drop your meme';
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

  if (/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)[\w-]+/.test(v)) {
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

// ── Escape ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.getElementById('deck-modal').classList.contains('open')) { closeDeckModal(); }
    else if (document.getElementById('fav-modal').classList.contains('open')) { document.getElementById('fav-modal').classList.remove('open'); }
    else if (!isPanelActive('compose')) { showTab('compose'); }
    else window.sender.close();
  }
});
capInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
capBottomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// ── Send ──────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', send);

async function send() {
  await applyPastedUrl();
  const url          = mediaUrl || null;
  const target       = targetSel.value || null;
  const captionTop   = capInput.value.trim() || null;
  const captionBottom = capBottomInput.value.trim() || null;
  // Combined line drives TTS and the legacy caption pill on non-image drops.
  const caption      = [captionTop, captionBottom].filter(Boolean).join(' ') || null;
  const effects      = [...activeEffects];

  const wantRepeat  = trimScrubbable && trimRepeat > 1;
  const useTrim     = trimScrubbable && videoDuration > 0 &&
                      (trimStart > 0.05 || trimEnd < videoDuration - 0.05 || wantRepeat);
  const trimStartVal = useTrim ? +Math.max(0, trimStart).toFixed(2) : null;
  const trimEndVal   = useTrim ? +Math.min(videoDuration, trimEnd).toFixed(2) : null;
  const loopTimesVal = useTrim ? trimRepeat : null;

  if (!url) { setStatus('Add a URL or drop a file', 'err'); return; }

  sendBtn.disabled = true;
  try {
    setStatus('Sending…');
    const drop = effectiveDrop();
    const result = await window.sender.sendDrop({
      url, target, caption, captionTop, captionBottom, effects, audioUrl: null,
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
        captionTop,
        captionBottom,
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
      showTab('compose');
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
  clearMedia(); urlPaste.value = ''; capInput.value = ''; capBottomInput.value = '';
  targetSel.value = '';
  activeEffects.clear();
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
}

// ── Clip library ──────────────────────────────────────────────────────────────
let libraryCache  = [];
let librarySearch = '';

// Build a sensible default name from a URL or filename, so saving needs no prompt.
function autoClipName(src, fallback) {
  if (!src) return fallback || 'Clip';
  if (/tiktok\.com/.test(src))        return 'TikTok clip';
  if (/(?:twitter|x)\.com/.test(src)) return 'X clip';
  if (/youtu/.test(src))              return 'YouTube clip';
  try {
    const last = src.split('?')[0].split('/').filter(Boolean).pop() || '';
    const base = decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
    if (base) return base.slice(0, 40);
  } catch {}
  return fallback || 'Clip';
}

const libSearchInput = document.getElementById('lib-search');
libSearchInput.addEventListener('input', () => {
  librarySearch = libSearchInput.value.trim().toLowerCase();
  renderLibrary();
});

async function renderLibrary() {
  libraryCache = await window.sender.libraryList();
  const items = librarySearch
    ? libraryCache.filter(c => (c.name || '').toLowerCase().includes(librarySearch))
    : libraryCache;
  libraryGrid.innerHTML = '';
  if (!items.length) {
    libraryEmpty.style.display = 'block';
    libraryEmpty.textContent = libraryCache.length
      ? 'No clips match your search'
      : 'No clips yet — paste a link or drop a video below to save your first one';
    return;
  }
  libraryEmpty.style.display = 'none';
  items.forEach(entry => libraryGrid.appendChild(renderClipTile(entry)));
}

function renderClipTile(entry) {
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
  name.title = 'Click to rename';
  name.addEventListener('click', (e) => { e.stopPropagation(); beginRename(entry, name); });

  const del = document.createElement('button');
  del.className = 'clip-del'; del.textContent = '✕';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    libraryCache = await window.sender.libraryDelete(entry.id);
    renderLibrary();
  });

  const toDeck = document.createElement('button');
  toDeck.className = 'clip-deck'; toDeck.textContent = '🎛'; toDeck.title = 'Add to Deck';
  toDeck.addEventListener('click', (e) => { e.stopPropagation(); addClipToDeck(entry); });

  tile.addEventListener('click', () => loadLibraryClip(entry, tile));
  tile.appendChild(vid); tile.appendChild(del); tile.appendChild(toDeck); tile.appendChild(name);
  return tile;
}

// Drop a library clip straight onto the first free Deck slot (grows a row if full).
async function addClipToDeck(entry) {
  const deck = (await window.sender.getDeck()) || { cols: 4, rows: 3, buttons: [] };
  if (!Array.isArray(deck.buttons)) deck.buttons = [];
  const total = deck.cols * deck.rows;
  let slot = -1;
  for (let i = 0; i < total; i++) { if (!deck.buttons.find(b => b.slot === i)) { slot = i; break; } }
  if (slot === -1) {
    if (deck.rows < 6) { deck.rows += 1; slot = total; }   // make room with one more row
    else { setStatus('🎛 Deck is full — free a slot first', 'err'); setTimeout(() => setStatus(''), 2500); return; }
  }
  const pos = ANCHOR_MAP['center'];
  deck.buttons.push({
    id: 'd' + Date.now(), slot, icon: '🎬', label: (entry.name || 'Meme').slice(0, 18),
    clipId: entry.id, url: null, isVideo: true, effects: [], size: 'm', anchor: 'center',
    positionX: pos.positionX, positionY: pos.positionY, caption: null, target: null, hotkey: '',
  });
  await window.sender.saveDeck(deck);
  setStatus('🎛 Added to Deck — set a hotkey in the Deck tab', 'ok');
  setTimeout(() => setStatus(''), 2600);
}

// Inline rename — click a clip's name, type, Enter to save (Esc to cancel).
function beginRename(entry, nameEl) {
  const input = document.createElement('input');
  input.className = 'clip-name-input';
  input.value = entry.name;
  input.maxLength = 60;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    if (save) {
      const v = input.value.trim();
      if (v && v !== entry.name) { entry.name = v; await window.sender.libraryRename(entry.id, v); }
    }
    renderLibrary();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

async function loadLibraryClip(entry, tile) {
  const busy = document.createElement('div');
  busy.className = 'clip-sending'; busy.textContent = 'Loading…';
  tile.appendChild(busy);
  try {
    const up = await window.sender.libraryUpload(entry.id);
    if (up.error || !up.url) throw new Error(up.error || 'upload failed');
    setMediaUrl(up.url, entry.name, true);
    busy.remove();
    showTab('compose');
    capInput.focus();
    setStatus('✓ Loaded — add a caption & send', 'ok');
    setTimeout(() => setStatus(''), 2000);
  } catch (err) {
    busy.textContent = '✗ ' + err.message;
    setTimeout(() => busy.remove(), 1500);
  }
}

// ── Save to library — instant, no modal, auto-named (rename later by clicking) ──
async function saveLinkToLibrary(url) {
  if (!url) return;
  setStatus('Saving…');
  const res = await window.sender.librarySave({ url, name: autoClipName(url) });
  if (res.error) { setStatus('✗ ' + res.error, 'err'); setTimeout(() => setStatus(''), 2800); return; }
  setStatus('📚 Saved to library!', 'ok'); setTimeout(() => setStatus(''), 1500);
  if (isPanelActive('library')) renderLibrary();
}
async function saveFileToLibrary(file) {
  if (!file.type.startsWith('video/')) { setStatus('Library saves videos only', 'err'); setTimeout(() => setStatus(''), 2200); return; }
  setStatus('Saving…');
  const ab = await file.arrayBuffer();
  const res = await window.sender.librarySaveBuffer(ab, autoClipName(file.name, 'Clip'));
  if (res.error) { setStatus('✗ ' + res.error, 'err'); setTimeout(() => setStatus(''), 2800); return; }
  setStatus('📚 Saved to library!', 'ok'); setTimeout(() => setStatus(''), 1500);
  if (isPanelActive('library')) renderLibrary();
}

// Compose ★ Save — one click, auto-named from the caption/label.
saveClipBtn.addEventListener('click', async () => {
  if (!mediaUrl) return;
  saveClipBtn.disabled = true;
  const name = capInput.value.trim() || autoClipName(mediaUrl, urlText.textContent);
  const res = await window.sender.librarySave({ url: mediaUrl, name });
  saveClipBtn.disabled = false;
  if (res.error) { setStatus('✗ ' + res.error, 'err'); setTimeout(() => setStatus(''), 2800); return; }
  setStatus('📚 Saved to library!', 'ok'); setTimeout(() => setStatus(''), 1500);
  if (isPanelActive('library')) renderLibrary();
});

// Drop a video file (or a dragged link) straight onto the Library tab.
const libPanel = document.getElementById('library-panel');
let libDragCount = 0;
libPanel.addEventListener('dragenter', (e) => { e.preventDefault(); libDragCount++; libPanel.classList.add('lib-drag'); });
libPanel.addEventListener('dragover',  (e) => e.preventDefault());
libPanel.addEventListener('dragleave', () => { libDragCount--; if (libDragCount <= 0) { libDragCount = 0; libPanel.classList.remove('lib-drag'); } });
libPanel.addEventListener('drop', async (e) => {
  e.preventDefault(); e.stopPropagation();
  libDragCount = 0; libPanel.classList.remove('lib-drag');
  const file = [...(e.dataTransfer?.files || [])][0];
  const text = (e.dataTransfer?.getData('text') || '').trim();
  if (file) await saveFileToLibrary(file);
  else if (text.startsWith('http')) await saveLinkToLibrary(text);
});

// ── Settings tab ──────────────────────────────────────────────────────────────
const SET_RANGES = [['duration', 'durationVal'], ['masterVolume', 'masterVolumeVal'], ['volumeSfx', 'volumeSfxVal'], ['volumeVoice', 'volumeVoiceVal']];
SET_RANGES.forEach(([key, disp]) => {
  const input = document.getElementById(key);
  const out   = document.getElementById(disp);
  if (input && out) input.addEventListener('input', () => { out.textContent = input.value; });
});
function updateRangeDisplays() {
  SET_RANGES.forEach(([key, disp]) => {
    const input = document.getElementById(key);
    const out   = document.getElementById(disp);
    if (input && out) out.textContent = input.value;
  });
}

async function loadSettingsForm() {
  const s = await window.sender.getSettings();
  document.getElementById('serverUrl').value = s.serverUrl || '';
  document.getElementById('discordUsername').value = s.discordUsername || '';
  document.getElementById('duration').value = Math.round((s.duration || 5000) / 1000);
  document.getElementById('masterVolume').value = s.masterVolume ?? 100;
  document.getElementById('volumeSfx').value = s.volumeSfx ?? 80;
  document.getElementById('volumeVoice').value = s.volumeVoice ?? 100;
  document.getElementById('giphyApiKey').value = s.giphyApiKey || '';
  document.getElementById('tryhardMode').checked = !!s.tryhardMode;
  document.getElementById('snipHotkey').value = s.snipHotkey ?? 'CommandOrControl+Shift+S';
  updateRangeDisplays();
  const knownVoices = ['g-en', 'g-fr', 'sam', 'mike', 'mary'];
  document.getElementById('ttsVoice').value = knownVoices.includes(s.ttsVoice) ? s.ttsVoice : '';
}

document.getElementById('settings-save-btn').addEventListener('click', async () => {
  const ns = {
    serverUrl:       document.getElementById('serverUrl').value,
    discordUsername: document.getElementById('discordUsername').value,
    duration:        Number(document.getElementById('duration').value) * 1000,
    masterVolume:    Number(document.getElementById('masterVolume').value),
    volumeSfx:       Number(document.getElementById('volumeSfx').value),
    volumeVoice:     Number(document.getElementById('volumeVoice').value),
    giphyApiKey:     document.getElementById('giphyApiKey').value,
    tryhardMode:     document.getElementById('tryhardMode').checked,
    ttsVoice:        document.getElementById('ttsVoice').value,
    snipHotkey:      document.getElementById('snipHotkey').value,
  };
  await window.sender.saveSettings(ns);
  const st = document.getElementById('settings-status');
  st.textContent = '✅ Saved!';
  setTimeout(() => { st.textContent = ''; }, 2000);
});

document.getElementById('settings-update-btn').addEventListener('click', async () => {
  const st = document.getElementById('settings-update-status');
  st.textContent = '⏳ Checking…';
  const result = await window.sender.checkForUpdates();
  if (result.status === 'dev') st.textContent = '⚠️ Only works in the installed version (not dev mode).';
});
if (window.sender.onUpdateStatus) {
  window.sender.onUpdateStatus((msg) => {
    const st = document.getElementById('settings-update-status');
    if (st) st.textContent = msg;
  });
}

// ── Meme Deck ───────────────────────────────────────────────────────────────────
// Stream Deck-style grid. Each key fires a saved meme on click or via a global
// hotkey (works even with the window closed — that's the point: in-game).
let deckState   = { cols: 4, rows: 3, buttons: [] };
let deckEditSlot = null;   // grid slot index being configured
let deckEditId   = null;   // existing button id, or null for a new one
let deckFxSel    = new Set();
let deckSize     = 'm';
let deckAnchor   = 'center';
let deckHotkey   = '';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

let deckClipMap = {};   // clipId → library entry (for key thumbnails)

async function renderDeck() {
  deckState = (await window.sender.getDeck()) || { cols: 4, rows: 3, buttons: [] };
  if (!Array.isArray(deckState.buttons)) deckState.buttons = [];

  // Map saved clips so configured keys can show a real video thumbnail.
  try {
    const clips = await window.sender.libraryList();
    deckClipMap = Object.fromEntries((clips || []).map(c => [c.id, c]));
  } catch { deckClipMap = {}; }

  document.getElementById('deck-cols').textContent = deckState.cols;
  document.getElementById('deck-rows').textContent = deckState.rows;

  const grid = document.getElementById('deck-grid');
  grid.style.gridTemplateColumns = `repeat(${deckState.cols}, 1fr)`;
  grid.style.gridTemplateRows    = `repeat(${deckState.rows}, 1fr)`;
  grid.innerHTML = '';
  const total = deckState.cols * deckState.rows;
  for (let i = 0; i < total; i++) {
    const btn = deckState.buttons.find(b => b.slot === i);
    grid.appendChild(btn ? deckKeyConfigured(btn) : deckKeyEmpty(i));
  }
}

function deckKeyEmpty(slot) {
  const el = document.createElement('div');
  el.className = 'deck-key empty';
  el.innerHTML = '<div class="deck-key-plus">＋</div><div class="deck-key-add">Add meme</div>';
  el.addEventListener('click', () => openDeckModal(slot, null));
  return el;
}

// Where a resting (paused) video parks so the key shows a real frame, not black.
const DECK_POSTER_T = 0.1;

// Build the visual thumbnail for a key: library clip → looping video on hover,
// image/gif URL → image, embeds (TikTok/YouTube/X) → big emoji.
function deckKeyThumb(btn) {
  const thumb = document.createElement('div');
  thumb.className = 'deck-key-thumb';
  const emoji = () => { thumb.innerHTML = `<div class="deck-key-emoji">${btn.icon || '🎬'}</div>`; };

  const makeVideo = (src) => {
    const v = document.createElement('video');
    v.src = src; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
    v.onerror = emoji;
    // Seek a hair past 0 so a real frame paints as the poster (a paused <video>
    // with no poster otherwise renders black until it's played).
    v.addEventListener('loadeddata', () => { try { v.currentTime = DECK_POSTER_T; } catch {} }, { once: true });
    thumb.appendChild(v);
    return v;
  };

  if (btn.clipId && deckClipMap[btn.clipId]) {
    return { thumb, video: makeVideo(`clip://clips/${deckClipMap[btn.clipId].file}`) };
  }
  const url = btn.url || '';
  if (url && !isEmbedUrl(url) && !btn.isVideo) {
    const img = document.createElement('img');
    img.src = url; img.loading = 'lazy'; img.onerror = emoji;
    thumb.appendChild(img);
    return { thumb, video: null };
  }
  if (url && btn.isVideo && !isEmbedUrl(url)) {
    return { thumb, video: makeVideo(url) };
  }
  emoji();
  return { thumb, video: null };
}

function deckKeyConfigured(btn) {
  const el = document.createElement('div');
  el.className = 'deck-key configured';

  const { thumb, video } = deckKeyThumb(btn);
  el.appendChild(thumb);

  if (video) {
    el.addEventListener('mouseenter', () => { video.play().catch(() => {}); });
    el.addEventListener('mouseleave', () => { try { video.pause(); video.currentTime = DECK_POSTER_T; } catch {} });
  }

  const bar = document.createElement('div');
  bar.className = 'deck-key-bar';
  bar.innerHTML = `<span class="deck-key-tag">${btn.icon || '🎬'}</span>` +
                  `<span class="deck-key-label"></span>`;
  bar.querySelector('.deck-key-label').textContent = btn.label || 'Meme';
  el.appendChild(bar);

  if (btn.hotkey) {
    const hk = document.createElement('div');
    hk.className = 'deck-key-hk'; hk.textContent = prettyHotkey(btn.hotkey);
    el.appendChild(hk);
  }

  const edit = document.createElement('button');
  edit.className = 'deck-key-edit'; edit.textContent = '✎'; edit.title = 'Edit';
  edit.addEventListener('click', (e) => { e.stopPropagation(); openDeckModal(btn.slot, btn.id); });
  el.appendChild(edit);

  el.addEventListener('click', () => fireDeckKey(btn, el));
  return el;
}

function prettyHotkey(h) { return h.replace('CommandOrControl', 'Ctrl'); }

async function fireDeckKey(btn, el) {
  el.classList.remove('fire-ok', 'fire-err');
  el.classList.add('firing');
  let r;
  try { r = await window.sender.fireDeck(btn.id); } catch { r = { error: 'failed' }; }
  el.classList.remove('firing');
  const ok = r && r.ok;
  el.classList.add(ok ? 'fire-ok' : 'fire-err');
  setTimeout(() => el.classList.remove('fire-ok', 'fire-err'), 700);
}

// ── Grid size steppers ──
async function changeDeckDim(which, delta) {
  const cols = which === 'cols' ? clamp(deckState.cols + delta, 2, 6) : deckState.cols;
  const rows = which === 'rows' ? clamp(deckState.rows + delta, 1, 6) : deckState.rows;
  if (cols === deckState.cols && rows === deckState.rows) return;
  deckState = { ...deckState, cols, rows };
  await window.sender.saveDeck(deckState);
  renderDeck();
}
document.getElementById('deck-col-dn').addEventListener('click', () => changeDeckDim('cols', -1));
document.getElementById('deck-col-up').addEventListener('click', () => changeDeckDim('cols', +1));
document.getElementById('deck-row-dn').addEventListener('click', () => changeDeckDim('rows', -1));
document.getElementById('deck-row-up').addEventListener('click', () => changeDeckDim('rows', +1));

// ── Config modal ──
function openDeckModal(slot, id) {
  deckEditSlot = slot; deckEditId = id;
  const btn = id ? deckState.buttons.find(b => b.id === id) : null;

  populateDeckClips(btn);
  document.getElementById('deck-icon').value    = btn?.icon || '';
  document.getElementById('deck-label').value   = btn?.label || '';
  document.getElementById('deck-url').value     = btn?.url || '';
  document.getElementById('deck-caption').value = btn?.caption || '';
  deckSize   = btn?.size   || 'm';      setDeckSize(deckSize);
  deckAnchor = btn?.anchor || 'center'; setDeckAnchor(deckAnchor);
  deckFxSel  = new Set(btn?.effects || []); renderDeckFx();
  deckHotkey = btn?.hotkey || '';
  document.getElementById('deck-hotkey').value = prettyHotkey(deckHotkey);
  document.getElementById('deck-hotkey-warn').textContent = '';
  document.getElementById('deck-media-status').textContent = '';
  document.getElementById('deck-modal-title').textContent = id ? 'Edit button' : 'New button';
  document.getElementById('deck-save-del').classList.toggle('hidden', !id);

  document.getElementById('deck-modal').classList.add('open');
  setTimeout(() => document.getElementById('deck-label').focus(), 50);
}
function closeDeckModal() {
  document.getElementById('deck-modal').classList.remove('open');
  document.getElementById('deck-hotkey').classList.remove('capturing');
}

async function populateDeckClips(btn) {
  const sel = document.getElementById('deck-clip');
  sel.innerHTML = '<option value="">— pick a library clip —</option>';
  let clips = [];
  try { clips = await window.sender.libraryList(); } catch {}
  clips.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  });
  sel.value = btn?.clipId || '';
}

// Build the effect chips once (cloned from the Compose list so they always match).
function buildDeckFx() {
  const wrap = document.getElementById('deck-fx');
  wrap.innerHTML = '';
  document.querySelectorAll('#advanced .chip[data-fx]').forEach(src => {
    const chip = document.createElement('div');
    chip.className = 'chip'; chip.dataset.fx = src.dataset.fx; chip.textContent = src.textContent;
    chip.addEventListener('click', () => {
      const fx = chip.dataset.fx;
      if (deckFxSel.has(fx)) { deckFxSel.delete(fx); chip.classList.remove('active'); }
      else { deckFxSel.add(fx); chip.classList.add('active'); }
    });
    wrap.appendChild(chip);
  });
}
function renderDeckFx() {
  document.querySelectorAll('#deck-fx .chip').forEach(c => c.classList.toggle('active', deckFxSel.has(c.dataset.fx)));
}
buildDeckFx();

document.querySelectorAll('#deck-size .size-chip').forEach(b => b.addEventListener('click', () => setDeckSize(b.dataset.size)));
function setDeckSize(s) {
  deckSize = s;
  document.querySelectorAll('#deck-size .size-chip').forEach(b => b.classList.toggle('active', b.dataset.size === s));
}
document.querySelectorAll('#deck-anchor .anchor-btn').forEach(b => b.addEventListener('click', () => setDeckAnchor(b.dataset.anchor)));
function setDeckAnchor(a) {
  deckAnchor = a;
  document.querySelectorAll('#deck-anchor .anchor-btn').forEach(b => b.classList.toggle('active', b.dataset.anchor === a));
}

document.getElementById('deck-use-compose').addEventListener('click', () => {
  if (!mediaUrl) { document.getElementById('deck-media-status').textContent = '⚠ Nothing loaded in Compose'; return; }
  document.getElementById('deck-clip').value = '';
  document.getElementById('deck-url').value = mediaUrl;
  document.getElementById('deck-media-status').textContent = '✓ Using current Compose media';
});

// ── Hotkey capture ──
const KEY_MAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
function accelFromEvent(e) {
  const key = e.key;
  if (key === 'Escape') return { cancel: true };
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;   // wait for the real key
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey)  mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let k = key;
  if (/^[a-z]$/i.test(k))                 k = k.toUpperCase();
  else if (/^[0-9]$/.test(k))             k = k;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) k = k;
  else if (KEY_MAP[k])                    k = KEY_MAP[k];
  else if (k.length !== 1)               return { warn: 'Unsupported key — try a letter, number or F-key.' };
  if (!mods.length) return { warn: 'Add Ctrl / Alt / Shift — a bare key would hijack typing everywhere.' };
  return { accel: [...mods, k].join('+') };
}
const hkInput = document.getElementById('deck-hotkey');
hkInput.addEventListener('focus', () => hkInput.classList.add('capturing'));
hkInput.addEventListener('blur',  () => hkInput.classList.remove('capturing'));
hkInput.addEventListener('keydown', (e) => {
  e.preventDefault();
  const r = accelFromEvent(e);
  if (r === null) return;
  if (r.cancel) { hkInput.blur(); return; }
  const warnEl = document.getElementById('deck-hotkey-warn');
  if (r.warn) { warnEl.textContent = '⚠ ' + r.warn; return; }
  deckHotkey = r.accel;
  hkInput.value = prettyHotkey(r.accel);
  warnEl.textContent = '';
});
document.getElementById('deck-hotkey-clear').addEventListener('click', () => {
  deckHotkey = ''; hkInput.value = ''; document.getElementById('deck-hotkey-warn').textContent = '';
});

// ── Save / delete ──
async function saveDeckButton() {
  const clipId = document.getElementById('deck-clip').value || null;
  const url    = document.getElementById('deck-url').value.trim() || null;
  const mediaStatus = document.getElementById('deck-media-status');
  if (!clipId && !url) { mediaStatus.textContent = '⚠ Pick a library clip or paste a link first'; return; }

  if (deckHotkey) {
    const clash = deckState.buttons.find(b => b.hotkey === deckHotkey && b.id !== deckEditId);
    if (clash) {
      document.getElementById('deck-hotkey-warn').textContent =
        `⚠ ${prettyHotkey(deckHotkey)} already bound to "${clash.label || 'another button'}"`;
      return;
    }
  }

  const pos = ANCHOR_MAP[deckAnchor] || ANCHOR_MAP['center'];
  const isVideo = !!clipId || /\.(mp4|webm)(\?|$)/i.test(url || '') || /tiktok|twitter|x\.com|youtu/.test(url || '');
  const btn = {
    id:        deckEditId || ('d' + Date.now()),
    slot:      deckEditSlot,
    icon:      document.getElementById('deck-icon').value.trim() || '🎬',
    label:     document.getElementById('deck-label').value.trim() || 'Meme',
    clipId,
    url:       clipId ? null : url,
    isVideo,
    effects:   [...deckFxSel],
    size:      deckSize,
    anchor:    deckAnchor,
    positionX: pos.positionX,
    positionY: pos.positionY,
    caption:   document.getElementById('deck-caption').value.trim() || null,
    target:    null,
    hotkey:    deckHotkey || '',
  };
  const buttons = deckState.buttons.filter(b => b.id !== btn.id);
  buttons.push(btn);
  deckState = { ...deckState, buttons };
  await window.sender.saveDeck(deckState);
  closeDeckModal();
  renderDeck();
}
async function deleteDeckButton() {
  if (!deckEditId) return;
  deckState = { ...deckState, buttons: deckState.buttons.filter(b => b.id !== deckEditId) };
  await window.sender.saveDeck(deckState);
  closeDeckModal();
  renderDeck();
}
document.getElementById('deck-save-ok').addEventListener('click', saveDeckButton);
document.getElementById('deck-save-del').addEventListener('click', deleteDeckButton);
document.getElementById('deck-save-cancel').addEventListener('click', closeDeckModal);

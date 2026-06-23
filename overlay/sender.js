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

// ── Clout economy (client mirror of server costs, for display only) ─────────────
const UNLOCK_COSTS = {
  spin: 0, fade: 0, drop: 50, slide: 50, zoom: 80, flip: 80, glitch: 150,
  shake: 50, pulse: 50, wobble: 80, 'spin-loop': 80, rainbow: 120, float: 50,
  slam: 200, flash: 120, glow: 120,
  'size-s': 0, 'size-m': 0, 'size-l': 100, 'size-xl': 250,
};
let myUnlocks    = ['spin', 'fade', 'size-s', 'size-m'];
let cloutEnabled = false;   // true once the server returns a real player (economy on)

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
const PANELS = { compose: 'compose-panel', library: 'library-panel', gif: 'gif-panel', history: 'history-panel', settings: 'settings-panel' };

function isPanelActive(name) {
  return document.getElementById(PANELS[name]).classList.contains('active');
}

function showTab(name) {
  if (!PANELS[name]) return;
  tabBtns.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  Object.entries(PANELS).forEach(([k, id]) => document.getElementById(id).classList.toggle('active', k === name));
  if (name === 'library')  { buildSituationFilter(); renderLibrary(); }
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
loadPlayer();
if (window.sender.onCloutUpdate) {
  window.sender.onCloutUpdate(d => { if (d && d.clout != null) updateCloutHud(d.clout, d.rank); });
}

// ── Clout economy: HUD + lock/unlock ────────────────────────────────────────────
function updateCloutHud(clout, rank) {
  const hud = document.getElementById('clout-hud');
  if (clout == null) { hud.classList.add('hidden'); return; }
  document.getElementById('clout-amount').textContent = Number(clout).toLocaleString();
  document.getElementById('clout-rank').textContent = rank || '';
  hud.classList.remove('hidden');
}

async function loadPlayer() {
  let p;
  try { p = await window.sender.getPlayer(); } catch { p = null; }
  if (!p || p.error || p.clout == null) { cloutEnabled = false; renderEconomy(); return; }
  cloutEnabled = true;
  myUnlocks = p.unlocks || myUnlocks;
  updateCloutHud(p.clout, p.rank);
  renderEconomy();
}

// Paint locked state on effect + size chips. When economy is off, nothing locks.
function renderEconomy() {
  document.querySelectorAll('.chip[data-fx]').forEach(chip => {
    const fx = chip.dataset.fx;
    const locked = cloutEnabled && (UNLOCK_COSTS[fx] || 0) > 0 && !myUnlocks.includes(fx);
    chip.classList.toggle('locked', locked);
    if (locked) chip.dataset.cost = UNLOCK_COSTS[fx]; else chip.removeAttribute('data-cost');
    if (locked && activeEffects.has(fx)) { activeEffects.delete(fx); chip.classList.remove('active'); }
  });
  document.querySelectorAll('.size-chip').forEach(chip => {
    const id = 'size-' + chip.dataset.size;
    const locked = cloutEnabled && (UNLOCK_COSTS[id] || 0) > 0 && !myUnlocks.includes(id);
    chip.classList.toggle('locked', locked);
  });
}

async function tryUnlock(itemId) {
  const cost = UNLOCK_COSTS[itemId] || 0;
  const label = itemId.startsWith('size-') ? itemId.slice(5).toUpperCase() + ' size' : itemId;
  if (!window.confirm(`Unlock "${label}" for ${cost} 🪙 ?`)) return;
  setStatus('Unlocking…');
  let r;
  try { r = await window.sender.unlockItem(itemId); } catch { r = null; }
  if (!r || r.error) {
    const msg = r && r.error === 'insufficient' ? 'Not enough Clout' : (r && r.error) || 'Unlock failed';
    setStatus('✗ ' + msg, 'err'); setTimeout(() => setStatus(''), 2200); return;
  }
  myUnlocks = r.unlocks || myUnlocks;
  updateCloutHud(r.clout, r.rank);
  renderEconomy();
  setStatus('✓ Unlocked!', 'ok'); setTimeout(() => setStatus(''), 1500);
}

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
    if (btn.classList.contains('locked')) { tryUnlock('size-' + btn.dataset.size); return; }
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
    if (chip.classList.contains('locked')) { tryUnlock(fx); return; }
    if (activeEffects.has(fx)) { activeEffects.delete(fx); chip.classList.remove('active'); }
    else { activeEffects.add(fx); chip.classList.add('active'); }
  });
});

// ── Escape ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.getElementById('lib-modal').classList.contains('open')) { closeLibModal(); }
    else if (document.getElementById('fav-modal').classList.contains('open')) { document.getElementById('fav-modal').classList.remove('open'); }
    else if (!isPanelActive('compose')) { showTab('compose'); }
    else window.sender.close();
  }
});
capInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// ── Send ──────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', send);

async function send() {
  await applyPastedUrl();
  const url          = mediaUrl || null;
  const target       = targetSel.value || null;
  const caption      = capInput.value.trim() || null;
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
      url, target, caption, effects, audioUrl: null,
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
      if (result.clout != null) updateCloutHud(result.clout, result.rank);
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
  clearMedia(); urlPaste.value = ''; capInput.value = '';
  targetSel.value = '';
  activeEffects.clear();
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
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

function buildSituationFilter() {
  const wrap = document.getElementById('situation-filter');
  wrap.innerHTML = '';
  const all = ['all', ...SITUATIONS.map(s => s.id)];
  all.forEach(id => {
    const chip = document.createElement('div');
    chip.className = 'sit-chip' + (id === activeSituation ? ' active' : '');
    chip.textContent = id === 'all' ? '✨ All' : SIT_LABEL[id];
    chip.addEventListener('click', () => { activeSituation = id; buildSituationFilter(); renderLibrary(); });
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
      : 'No clips saved yet — paste a video in Compose and hit ★ Save';
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
  if (isPanelActive('library')) renderLibrary();
});
document.getElementById('lib-save-cancel').addEventListener('click', closeLibModal);
document.getElementById('lib-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('lib-save-ok').click();
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
  document.getElementById('reactHotkey').value = s.reactHotkey ?? 'CommandOrControl+Shift+R';
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
    reactHotkey:     document.getElementById('reactHotkey').value,
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

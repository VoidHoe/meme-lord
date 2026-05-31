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
let loopEnabled    = false;
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
const loopRow     = document.getElementById('loop-row');
const loopChk     = document.getElementById('loop-chk');
const loopLabelText = document.getElementById('loop-label-text');
const loopSecs    = document.getElementById('loop-secs');
const loopSecsLabel = document.getElementById('loop-secs-label');
const loopHint    = document.getElementById('loop-hint');

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

// ── Init ──────────────────────────────────────────────────────────────────────
window.sender.getSettings().then(s => {
  micDeviceId = s.micDeviceId || '';
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

// ── Loop row ─────────────────────────────────────────────────────────────────
loopChk.addEventListener('click', toggleLoop);
document.querySelector('.loop-label').addEventListener('click', toggleLoop);

function toggleLoop() {
  if (loopRow.classList.contains('disabled')) return;
  loopEnabled = !loopEnabled;
  loopChk.classList.toggle('checked', loopEnabled);
  loopChk.textContent = loopEnabled ? '✓' : '';
  loopRow.classList.toggle('loop-active', loopEnabled);
  if (loopEnabled) {
    loopLabelText.textContent = 'Loop for';
    loopSecs.style.display = 'inline-block';
    loopSecsLabel.style.display = 'inline';
    loopHint.style.display = 'none';
  } else {
    loopLabelText.textContent = 'Loop';
    loopSecs.style.display = 'none';
    loopSecsLabel.style.display = 'none';
    loopHint.style.display = 'block';
    loopHint.textContent = 'plays once then disappears';
  }
}

function setLoopRowEnabled(enabled) {
  loopRow.classList.toggle('disabled', !enabled);
  if (!enabled) {
    loopEnabled = false;
    loopChk.classList.remove('checked');
    loopChk.textContent = '';
    loopRow.classList.remove('loop-active');
    loopLabelText.textContent = 'Loop';
    loopSecs.style.display = 'none';
    loopSecsLabel.style.display = 'none';
    loopHint.style.display = 'block';
    loopHint.textContent = 'load a video first';
  } else {
    loopHint.textContent = 'plays once then disappears';
  }
}

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

function setMediaUrl(url, label, isVideo = false) {
  mediaUrl = url; mediaIsVideo = isVideo; urlPaste.value = '';
  dropZone.classList.add('has-url');
  urlText.textContent = label || url;
  clearUrlBtn.style.display = 'block';
  setLoopRowEnabled(isVideo);
}

function clearMedia() {
  mediaUrl = null; mediaIsVideo = false;
  dropZone.classList.remove('has-url');
  urlText.textContent = 'Drop a file here, or paste a URL below';
  clearUrlBtn.style.display = 'none';
  setLoopRowEnabled(false);
}
clearUrlBtn.addEventListener('click', clearMedia);

urlPaste.addEventListener('keydown', (e) => { if (e.key === 'Enter') { applyPastedUrl(); send(); } });
urlPaste.addEventListener('blur', applyPastedUrl);
function applyPastedUrl() {
  const v = urlPaste.value.trim();
  if (!v.startsWith('http')) return;
  if (/tiktok\.com\/@[\w.]+\/video\/\d+/.test(v)) {
    setMediaUrl(v, '🎵 TikTok video', true); return;
  }
  if (/(?:twitter\.com|x\.com)\/\w+\/status\/\d+/.test(v)) {
    setMediaUrl(v, '🐦 Twitter / X post', true); return;
  }
  if (/(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/.test(v)) {
    setMediaUrl(v, '▶️ YouTube video', true); return;
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
    if (gifView.classList.contains('slide-in')) closeGifView();
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
  applyPastedUrl();
  const url          = mediaUrl || null;
  const target       = targetSel.value || null;
  const caption      = capInput.value.trim() || null;
  const effects      = [...activeEffects];
  const loopDuration = loopEnabled ? (parseInt(loopSecs.value) || 10) : null;

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
    const pos = ANCHOR_MAP[selectedAnchor] || ANCHOR_MAP['center'];
    const result = await window.sender.sendDrop({
      url, target, caption, effects, audioUrl,
      loop: loopEnabled,
      loopDuration,
      size: selectedSize,
      positionX: pos.positionX,
      positionY: pos.positionY,
    });
    if (result.ok) {
      setStatus('✓ Dropped!', 'ok');
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

// ── State ─────────────────────────────────────────────────────────────────────
const activeEffects = new Set();
let mediaRecorder  = null;
let recordedChunks = [];
let audioBlob      = null;
let recordingTimer = null;
let recordingSecs  = 0;
let mediaUrl       = null;  // URL résolue (drop ou paste)

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

// ── Init ──────────────────────────────────────────────────────────────────────
loadUsers();

// ── Users dropdown ────────────────────────────────────────────────────────────
async function loadUsers() {
  refreshBtn.classList.add('spinning');
  try {
    const result = await window.sender.getUsers();
    // Keep "Everyone", remove old options
    while (targetSel.options.length > 1) targetSel.remove(1);
    (result.users || []).forEach(username => {
      const opt = document.createElement('option');
      opt.value = username;
      opt.textContent = `@${username}`;
      targetSel.appendChild(opt);
    });
  } catch (e) { /* silently ignore */ }
  finally {
    setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
  }
}

refreshBtn.addEventListener('click', loadUsers);

// ── Drag and drop onto the form ───────────────────────────────────────────────
const form = document.getElementById('form');
let dragCounter = 0;

form.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dropZone.classList.add('drag-over');
  urlText.textContent = 'Release to upload…';
});

form.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropZone.classList.remove('drag-over');
    if (!mediaUrl) urlText.textContent = 'Drop image, GIF, or video here…';
  }
});

form.addEventListener('dragover', (e) => e.preventDefault());

form.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropZone.classList.remove('drag-over');

  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;

  const file = files[0];
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    setStatus('Only images and videos supported', 'err');
    urlText.textContent = 'Drop image, GIF, or video here…';
    return;
  }

  await uploadFile(file);
});

// Also allow dropping directly on the drop-zone div
dropZone.addEventListener('dragenter', (e) => e.preventDefault());
dropZone.addEventListener('dragover',  (e) => e.preventDefault());

async function uploadFile(file) {
  dropZone.classList.add('uploading');
  urlText.textContent = `Uploading ${file.name}…`;
  clearUrlBtn.style.display = 'none';
  setStatus('');

  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await window.sender.uploadMedia(arrayBuffer, file.type);
    if (result.error) throw new Error(result.error);

    setMediaUrl(result.url, file.name);
    setStatus('✓ File ready', 'ok');
    setTimeout(() => setStatus(''), 1500);
  } catch (err) {
    setStatus('Upload failed: ' + err.message, 'err');
    clearMedia();
  } finally {
    dropZone.classList.remove('uploading');
  }
}

function setMediaUrl(url, label) {
  mediaUrl = url;
  urlPaste.value = '';
  dropZone.classList.add('has-url');
  urlText.textContent = label || url;
  clearUrlBtn.style.display = 'block';
}

function clearMedia() {
  mediaUrl = null;
  dropZone.classList.remove('has-url');
  urlText.textContent = 'Drop image, GIF, or video here…';
  clearUrlBtn.style.display = 'none';
}

clearUrlBtn.addEventListener('click', clearMedia);

// ── Paste URL manually ────────────────────────────────────────────────────────
urlPaste.addEventListener('input', () => {
  const val = urlPaste.value.trim();
  if (val.startsWith('http')) {
    // Don't auto-set until they press Enter or leave
  }
});

urlPaste.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = urlPaste.value.trim();
    if (val) {
      mediaUrl = val;
      dropZone.classList.add('has-url');
      urlText.textContent = val;
      clearUrlBtn.style.display = 'block';
      urlPaste.value = '';
    }
    send();
  }
});

urlPaste.addEventListener('blur', () => {
  const val = urlPaste.value.trim();
  if (val.startsWith('http')) {
    mediaUrl = val;
    dropZone.classList.add('has-url');
    urlText.textContent = val;
    clearUrlBtn.style.display = 'block';
    urlPaste.value = '';
  }
});

// ── Effects chips ─────────────────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const fx = chip.dataset.fx;
    if (activeEffects.has(fx)) {
      activeEffects.delete(fx);
      chip.classList.remove('active');
    } else {
      activeEffects.add(fx);
      chip.classList.add('active');
    }
  });
});

// ── Close / Escape ────────────────────────────────────────────────────────────
document.getElementById('close-btn').addEventListener('click', () => window.sender.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.sender.close(); });
capInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// ── Microphone recording ──────────────────────────────────────────────────────
micBtn.addEventListener('click', toggleRecording);

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    recordedChunks = [];
    audioBlob = null;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
      stopTimer();
      micBtn.className = 'has-audio';
      micBtn.innerHTML = `🎤 ✓ ${formatTime(recordingSecs)}`;
      voiceLabel.textContent = `Voice note ready (${formatTime(recordingSecs)}) — click to re-record`;
      voiceLabel.className = 'active';
    };

    mediaRecorder.start();
    startTimer();
    micBtn.className = 'recording';
    micBtn.innerHTML = `⏹ ${formatTime(recordingSecs)}`;
    voiceLabel.textContent = 'Recording… click to stop';
    voiceLabel.className = '';

  } catch (err) {
    setStatus('Mic access denied', 'err');
  }
}

function startTimer() {
  recordingSecs = 0;
  recordingTimer = setInterval(() => {
    recordingSecs++;
    micBtn.innerHTML = `⏹ ${formatTime(recordingSecs)}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(recordingTimer);
  recordingTimer = null;
}

function formatTime(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// ── Send ──────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', send);

async function send() {
  const url     = mediaUrl || null;
  const target  = targetSel.value || null;
  const caption = capInput.value.trim() || null;
  const effects = [...activeEffects];

  if (!url && !audioBlob) {
    setStatus('Drop a file, paste a URL, or record audio', 'err');
    return;
  }

  sendBtn.disabled = true;

  try {
    let audioUrl = null;

    if (audioBlob) {
      setStatus('Uploading audio…');
      const ab = await audioBlob.arrayBuffer();
      const r  = await window.sender.uploadAudio(ab);
      if (r.error) throw new Error(r.error);
      audioUrl = r.url;
    }

    setStatus('Sending…');
    const result = await window.sender.sendDrop({ url, target, caption, effects, audioUrl });

    if (result.ok) {
      setStatus('✓ Dropped!', 'ok');
      reset();
      setTimeout(() => window.sender.close(), 700);
    } else {
      setStatus(result.error || 'Server error', 'err');
      sendBtn.disabled = false;
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'err');
    sendBtn.disabled = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className   = cls;
}

function reset() {
  clearMedia();
  urlPaste.value = '';
  capInput.value = '';
  targetSel.value = '';
  activeEffects.clear();
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  audioBlob = null;
  recordedChunks = [];
  stopTimer();
  micBtn.className    = '';
  micBtn.innerHTML    = '🎤 Record';
  voiceLabel.textContent = 'No recording';
  voiceLabel.className   = '';
}

// ── Mobile Quick Drop ───────────────────────────────────────────────────────
// Talks to the same server API the desktop sender uses. The password only gates
// this page's UI (soft lock); /api/drop and uploads stay open as before.

const ANCHOR_MAP = {
  'top-left':     { positionX: 15, positionY: 15 },
  'top-right':    { positionX: 85, positionY: 15 },
  'center':       { positionX: 50, positionY: 50 },
  'bottom-left':  { positionX: 15, positionY: 85 },
  'bottom-right': { positionX: 85, positionY: 85 },
};
const PW_KEY = 'memedrop_send_pw';

let pickedFile  = null;
let selectedSize   = localStorage.getItem('memedrop_size')   || 'm';
let selectedAnchor = localStorage.getItem('memedrop_anchor') || 'center';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const gate        = document.getElementById('gate');
const gateInput   = document.getElementById('gate-input');
const gateBtn     = document.getElementById('gate-btn');
const gateErr     = document.getElementById('gate-err');
const appEl       = document.getElementById('app');

const fileInput   = document.getElementById('file-input');
const fileEmpty   = document.getElementById('file-empty');
const filePreview = document.getElementById('file-preview');
const previewImg  = document.getElementById('preview-img');
const previewVid  = document.getElementById('preview-vid');
const fileClear   = document.getElementById('file-clear');
const urlInput    = document.getElementById('url-input');
const captionInput= document.getElementById('caption-input');
const targetSelect= document.getElementById('target-select');
const refreshBtn  = document.getElementById('refresh-btn');
const sizeChips   = document.getElementById('size-chips');
const anchorGrid  = document.getElementById('anchor-grid');
const sendBtn     = document.getElementById('send-btn');
const statusEl    = document.getElementById('status');

// ── Auth gate ─────────────────────────────────────────────────────────────────
async function postAuth(password) {
  try {
    const r = await fetch('/api/send-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return await r.json();
  } catch { return { ok: false, required: true }; }
}

function unlock() {
  gate.classList.add('hidden');
  appEl.classList.remove('hidden');
  loadUsers();
}

async function initAuth() {
  const probe = await postAuth('');           // no password → learn if a gate exists
  if (!probe.required) { unlock(); return; }   // no password configured

  const saved = localStorage.getItem(PW_KEY);
  if (saved) {
    const res = await postAuth(saved);
    if (res.ok) { unlock(); return; }
    localStorage.removeItem(PW_KEY);
  }
  gate.classList.remove('hidden');
  setTimeout(() => gateInput.focus(), 100);
}

async function tryUnlock() {
  const pw = gateInput.value;
  if (!pw) return;
  gateBtn.disabled = true; gateErr.textContent = '';
  const res = await postAuth(pw);
  gateBtn.disabled = false;
  if (res.ok) {
    localStorage.setItem(PW_KEY, pw);
    unlock();
  } else {
    gateErr.textContent = 'Wrong password';
    gateInput.select();
  }
}
gateBtn.addEventListener('click', tryUnlock);
gateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

// ── Users dropdown ─────────────────────────────────────────────────────────────
async function loadUsers() {
  refreshBtn.disabled = true;
  try {
    const r = await fetch('/api/users');
    const { users } = await r.json();
    const current = targetSelect.value;
    while (targetSelect.options.length > 1) targetSelect.remove(1);
    (users || []).forEach(u => {
      const opt = document.createElement('option');
      opt.value = u; opt.textContent = `@${u}`;
      targetSelect.appendChild(opt);
    });
    targetSelect.value = current;
  } catch {}
  refreshBtn.disabled = false;
}
refreshBtn.addEventListener('click', loadUsers);

// ── File picker ─────────────────────────────────────────────────────────────────
fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) {
    setStatus('Only images and videos', 'err'); fileInput.value = ''; return;
  }
  pickedFile = f;
  fileEmpty.classList.add('hidden');
  filePreview.classList.remove('hidden');
  if (f.type.startsWith('image/')) {
    previewImg.classList.remove('hidden');
    previewVid.classList.add('hidden');
    previewImg.src = URL.createObjectURL(f);
  } else {
    previewImg.classList.add('hidden');
    previewVid.classList.remove('hidden');
  }
});
fileClear.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  clearFile();
});
function clearFile() {
  pickedFile = null;
  fileInput.value = '';
  filePreview.classList.add('hidden');
  fileEmpty.classList.remove('hidden');
  previewImg.removeAttribute('src');
}

// ── Size chips ─────────────────────────────────────────────────────────────────
function setSize(size) {
  selectedSize = size;
  localStorage.setItem('memedrop_size', size);
  [...sizeChips.children].forEach(c => c.classList.toggle('active', c.dataset.size === size));
}
sizeChips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip'); if (chip) setSize(chip.dataset.size);
});

// ── Anchor grid ─────────────────────────────────────────────────────────────────
function setAnchor(anchor) {
  selectedAnchor = anchor;
  localStorage.setItem('memedrop_anchor', anchor);
  [...anchorGrid.querySelectorAll('.anchor')].forEach(a => a.classList.toggle('active', a.dataset.anchor === anchor));
}
anchorGrid.addEventListener('click', (e) => {
  const a = e.target.closest('.anchor'); if (a) setAnchor(a.dataset.anchor);
});

// ── Upload + send ──────────────────────────────────────────────────────────────
function fileMediaType(file) {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type === 'image/gif')      return 'gif';
  return 'image';
}

async function uploadFile(file) {
  const r = await fetch('/api/upload-media', {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  const j = await r.json();
  if (j.error || !j.url) throw new Error(j.error || 'upload failed');
  return j.url;
}

sendBtn.addEventListener('click', send);
async function send() {
  const url     = urlInput.value.trim();
  const caption = captionInput.value.trim() || null;
  const target  = targetSelect.value || null;
  const pos     = ANCHOR_MAP[selectedAnchor] || ANCHOR_MAP.center;

  if (!pickedFile && !url && !caption) {
    setStatus('Pick media, paste a link, or write a caption', 'err');
    return;
  }

  sendBtn.disabled = true;
  try {
    // File takes precedence; send a resolved media object. Otherwise hand the raw
    // URL to the server (it resolves TikTok/Twitter/YouTube/direct links).
    const body = {
      caption, target,
      size: selectedSize,
      positionX: pos.positionX,
      positionY: pos.positionY,
    };
    if (pickedFile) {
      setStatus('Uploading…');
      const uploadedUrl = await uploadFile(pickedFile);
      body.media = { type: fileMediaType(pickedFile), url: uploadedUrl };
    } else if (url) {
      body.mediaUrl = url;
    }

    setStatus('Dropping…');
    const r = await fetch('/api/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.ok) {
      setStatus('✓ Dropped!', 'ok');
      resetForm();
      setTimeout(() => setStatus(''), 1800);
    } else {
      setStatus(j.error || 'Server error', 'err');
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'err');
  } finally {
    sendBtn.disabled = false;
  }
}

function resetForm() {
  clearFile();
  urlInput.value = '';
  captionInput.value = '';
  // size / position / target stay sticky for the next quick drop
}

function setStatus(msg, cls = '') { statusEl.textContent = msg; statusEl.className = 'status ' + cls; }

// ── Init ─────────────────────────────────────────────────────────────────────
setSize(selectedSize);
setAnchor(selectedAnchor);
initAuth();

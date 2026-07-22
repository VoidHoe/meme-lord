const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut, session, protocol, shell, desktopCapturer, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { fileURLToPath, pathToFileURL } = require('url');
const Store = require('electron-store');
const { io } = require('socket.io-client');

const allowDevInstance = !app.isPackaged && process.argv.includes('--dev-multiple');
if (allowDevInstance) {
  const devUserData = path.join(app.getPath('appData'), 'memedrop-overlay-dev');
  app.setPath('userData', devUserData);
  app.commandLine.appendSwitch('disk-cache-dir', path.join(devUserData, 'Cache'));
}

const store = new Store({
  deserialize: (value) => JSON.parse(String(value).replace(/^\uFEFF/, '')),
  defaults: {
    serverUrl: 'https://memelord-production-3bbf.up.railway.app',
    discordUsername: '',
    positionX: 50,
    positionY: 50,
    duration: 5000,
    masterVolume: 100,
    volumeSfx: 80,
    volumeVoice: 100,
    effects: true,
    micDeviceId: '',
    favorites: [],
    anchorPosition: 'center',
    dropSize: 'm',
    history: [],
    library: [],
    ttsVoice: '',
    authToken: '',
    authUser: null,
    snipHotkey: 'CommandOrControl+Shift+S',
    chaseEnabled: false,
    chaseHotkey: '6',
    chaseTriggerMode: 'hold',
    chaseDuration: 60,
    chaseMusicUrl: 'https://youtu.be/N_og7Lok8j8',
    chaseMusicLibrary: [],
    chaseMusicMode: 'manual',
    chaseSelectedMusicId: '',
    chaseMusicStart: 10,
    chaseSfxDir: '',
    chaseSfxPrepared: null,
    chaseCheckpointSfxEnabled: true,
    chaseCheckpointSeconds: 30,
    facecamEnabled: false,
    facecamHotkey: '5',
    facecamTriggerMode: 'hold',
    facecamFps: 6,
    facecamDeviceId: '',
    facecamPositionX: 78,
    facecamPositionY: 8,
    facecamWidth: 220,
  },
});

// Removed product surfaces: discard obsolete local configuration left by older builds.
store.delete('deck');
store.delete('giphyApiKey');

// Local clip library — durable reaction clips saved to disk
const clipsDir = path.join(app.getPath('userData'), 'clips');
try { fs.mkdirSync(clipsDir, { recursive: true }); } catch {}
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm']);
const AUDIO_MIME = {
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};
const uploadedChaseAudio = new Map();

// The server deletes uploaded media after 5 min (see /api/upload-media). Cache each
// clip's hosted URL and reuse it within that window instead of re-uploading the
// whole file on every drop/fire. Keyed by clipId → { url, at }.
const clipUploadCache = new Map();
const CLIP_URL_TTL = 4 * 60 * 1000;   // 4 min — safety margin under the server's 5

// Upload a saved library clip and return its hosted { url }, reusing a recent
// upload when one is still alive on the server.
async function uploadLibraryClip(id) {
  const entry = getLibrary().find(x => x.id === id);
  if (!entry) return { error: 'clip not found' };

  const cached = clipUploadCache.get(id);
  if (cached && (Date.now() - cached.at) < CLIP_URL_TTL) {
    return { url: cached.url, cached: true };
  }

  const buf = fs.readFileSync(path.join(clipsDir, entry.file));
  const res = await uploadMediaBuffer(buf, 'video/mp4');
  if (res && res.url) clipUploadCache.set(id, { url: res.url, at: Date.now() });
  return res;
}
const DEFAULT_SERVER = 'https://memelord-production-3bbf.up.railway.app';

// clip:// streams saved library videos into the sender (must run before app ready)
protocol.registerSchemesAsPrivileged([
  { scheme: 'clip', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

let overlayWindow    = null;
let settingsWindow   = null;
let senderWindow     = null;
let snipWindow       = null;
let facecamWindow    = null;
let tray             = null;
let socketClient     = null;
let overlayRaiseTimer = null;
let chaseHotkeyActive = false;
let chaseHotkeyTimer = null;
let chaseHotkeyRepeatSeen = false;
let chaseToggleActive = false;
let chaseToggleHotkeyLocked = false;
let chaseToggleHotkeyTimer = null;
let chaseToggleAutoTimer = null;
let chaseHotkeyStartedAt = null;
let chaseToggleStartedAt = null;
let facecamHotkeyActive = false;
let facecamHotkeyTimer = null;
let facecamHotkeyRepeatSeen = false;
let facecamSessionId = null;
let facecamToggleHotkeyLocked = false;
let facecamToggleHotkeyTimer = null;
let lastFacecamFrameAt = 0;

function hasAuthSession() {
  return !!(store.get('authToken') && store.get('authUser')?.username);
}

function disconnectSocket() {
  if (!socketClient) return;
  socketClient.disconnect();
  socketClient = null;
}

function clearChaseState({ broadcastStop = false } = {}) {
  chaseHotkeyActive = false;
  chaseHotkeyRepeatSeen = false;
  chaseToggleActive = false;
  chaseToggleHotkeyLocked = false;
  if (chaseHotkeyTimer) clearTimeout(chaseHotkeyTimer);
  if (chaseToggleHotkeyTimer) clearTimeout(chaseToggleHotkeyTimer);
  if (chaseToggleAutoTimer) clearTimeout(chaseToggleAutoTimer);
  chaseHotkeyTimer = null;
  chaseToggleHotkeyTimer = null;
  chaseToggleAutoTimer = null;
  chaseHotkeyStartedAt = null;
  chaseToggleStartedAt = null;
  if (broadcastStop) sendChase('stop');
}

function setLoggedOutState() {
  clearChaseState({ broadcastStop: true });
  facecamHotkeyActive = false;
  facecamHotkeyRepeatSeen = false;
  facecamToggleHotkeyLocked = false;
  if (facecamHotkeyTimer) clearTimeout(facecamHotkeyTimer);
  if (facecamToggleHotkeyTimer) clearTimeout(facecamToggleHotkeyTimer);
  facecamHotkeyTimer = null;
  facecamToggleHotkeyTimer = null;
  stopFacecam();
  disconnectSocket();
  registerHotkey();
}

// Only allow one production MemeDrop at a time. Development can opt into a
// separate visual-test instance without closing the user's installed app.
if (!allowDevInstance && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (senderWindow && !senderWindow.isDestroyed()) senderWindow.focus();
    else createSenderWindow();
  });
}

// ── Fenêtres ──────────────────────────────────────────────────────────────────

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.moveTop();
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    if (overlayRaiseTimer) { clearInterval(overlayRaiseTimer); overlayRaiseTimer = null; }
  });

  // Re-raise every second — games in borderless windowed mode can temporarily
  // push the overlay down in z-order when they take focus.
  // NOTE: exclusive fullscreen games bypass the Windows compositor entirely;
  // nothing short of native DLL injection (like Discord overlay) can fix that.
  if (overlayRaiseTimer) clearInterval(overlayRaiseTimer);
  overlayRaiseTimer = setInterval(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      overlayWindow.moveTop();
    }
  }, 1000);
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    title: 'MemeDrop — Settings',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createSenderWindow() {
  if (senderWindow && !senderWindow.isDestroyed()) {
    senderWindow.focus();
    return;
  }

  senderWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    resizable: true,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    alwaysOnTop: false,
    title: 'MemeDrop',
    webPreferences: {
      preload: path.join(__dirname, 'sender-preload.js'),
      contextIsolation: true,
    },
  });

  senderWindow.loadFile(path.join(__dirname, 'sender.html'));
  senderWindow.on('closed', () => { senderWindow = null; });
}

function createFacecamWindow() {
  if (facecamWindow && !facecamWindow.isDestroyed()) return facecamWindow;

  facecamWindow = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'facecam-preload.js'),
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  facecamWindow.loadFile(path.join(__dirname, 'facecam.html'));
  facecamWindow.on('closed', () => { facecamWindow = null; });
  return facecamWindow;
}

function whenFacecamReady() {
  const win = createFacecamWindow();
  if (!win.webContents.isLoading()) return Promise.resolve(win);
  return new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => resolve(win));
  });
}

async function listFacecamDevices() {
  const win = await whenFacecamReady();
  return win.webContents.executeJavaScript(`
    (async () => {
      async function devices() {
        const list = await navigator.mediaDevices.enumerateDevices();
        return list
          .filter(device => device.kind === 'videoinput')
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || 'Camera ' + (index + 1),
          }));
      }
      let list = await devices();
      if (!list.some(device => device.label && !/^Camera \\d+$/.test(device.label))) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          stream.getTracks().forEach(track => track.stop());
          list = await devices();
        } catch {}
      }
      return list;
    })()
  `);
}

// Send a message to the sender once it has finished loading (creating it if needed).
function sendToSender(channel, payload) {
  if (!senderWindow) return;
  const go = () => { if (senderWindow && !senderWindow.isDestroyed()) senderWindow.webContents.send(channel, payload); };
  if (senderWindow.webContents.isLoading()) {
    senderWindow.webContents.once('did-finish-load', go);
  } else {
    go();
  }
}

// Open (or focus) the sender on a specific tab — Settings is now a tab here.
function openSenderTab(tab) {
  createSenderWindow();
  sendToSender('show-tab', tab);
}

// ── Snip (Phase 2): hotkey → freeze screen → drag a region → into Compose ──────

function closeSnipWindow() {
  if (snipWindow && !snipWindow.isDestroyed()) snipWindow.close();
}

async function captureSnip() {
  if (snipWindow && !snipWindow.isDestroyed()) return;  // already snipping
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;        // logical px
  const scale = display.scaleFactor || 1;

  let dataURL = '';
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
    if (src && src.thumbnail && !src.thumbnail.isEmpty()) dataURL = src.thumbnail.toDataURL();
  } catch (e) {
    console.error('[snip] capture error:', e.message);
  }
  if (!dataURL) { console.error('[snip] no screenshot captured'); return; }

  snipWindow = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width, height,
    frame: false, transparent: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false, hasShadow: false, enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'snip-preload.js'),
      contextIsolation: true,
    },
  });
  snipWindow.setAlwaysOnTop(true, 'screen-saver');
  snipWindow.loadFile(path.join(__dirname, 'snip.html'));
  snipWindow.webContents.once('did-finish-load', () => {
    if (!snipWindow || snipWindow.isDestroyed()) return;
    snipWindow.webContents.send('snip-init', { dataURL, width, height });
    snipWindow.focus();
  });
  snipWindow.on('closed', () => { snipWindow = null; });
}

// Upload raw image bytes to the server and return its hosted { url }.
async function uploadMediaBuffer(buffer, mimeType) {
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  const res = await fetch(`${serverUrl}/api/upload-media`, {
    method: 'POST', headers: { 'Content-Type': mimeType }, body: Buffer.from(buffer),
  });
  return res.json();
}

ipcMain.on('snip-cancel', closeSnipWindow);

ipcMain.on('snip-region', async (_e, bytes) => {
  closeSnipWindow();
  openSenderTab('compose');
  try {
    const r = await uploadMediaBuffer(bytes, 'image/png');
    if (r.error || !r.url) throw new Error(r.error || 'upload failed');
    sendToSender('snip-result', { url: r.url });
  } catch (err) {
    console.error('[snip] upload error:', err.message);
    sendToSender('snip-result', { error: err.message });
  }
});

// ── Socket ────────────────────────────────────────────────────────────────────

function connectSocket() {
  const settings = store.store;
  if (!hasAuthSession() || !settings.serverUrl || !settings.discordUsername) {
    disconnectSocket();
    return;
  }

  if (socketClient) socketClient.disconnect();

  socketClient = io(settings.serverUrl, {
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
  });

  socketClient.on('connect', () => {
    console.log('[socket] connecté au serveur');
    socketClient.emit('register', settings.discordUsername);
  });

  socketClient.on('drop', (event) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('drop', event);
    }
  });

  ['facecam-start', 'facecam-frame', 'facecam-stop'].forEach(channel => {
    socketClient.on(channel, (event) => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send(channel, event);
      }
    });
  });

  socketClient.on('disconnect', () => console.log('[socket] déconnecté'));
  socketClient.on('connect_error', (err) => console.error('[socket] erreur connexion:', err.message));
}

// ── Hotkey ────────────────────────────────────────────────────────────────────

function registerHotkey() {
  globalShortcut.unregisterAll();

  // Raccourci fenêtre d'envoi rapide (Ctrl+Shift+D)
  try {
    globalShortcut.register('CommandOrControl+Shift+D', () => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.focus();
      } else {
        createSenderWindow();
      }
    });
    console.log('[hotkey] sender enregistré: Ctrl+Shift+D');
  } catch (e) {
    console.error('[hotkey] sender erreur:', e.message);
  }

  // Raccourci snip de zone (par défaut Ctrl+Shift+S, configurable, vide = off)
  const snipKey = store.get('snipHotkey');
  if (snipKey) {
    try {
      globalShortcut.register(snipKey, captureSnip);
      console.log('[hotkey] snip enregistré:', snipKey);
    } catch (e) {
      console.error('[hotkey] snip erreur:', e.message);
    }
  }

  const chaseKey = store.get('chaseEnabled') ? store.get('chaseHotkey') : '';
  if (hasAuthSession() && chaseKey) {
    registerHotkeyVariants('chase', chaseKey, triggerChaseHotkey);
  }

  const facecamKey = store.get('facecamEnabled') ? store.get('facecamHotkey') : '';
  if (hasAuthSession() && facecamKey) {
    registerHotkeyVariants('facecam', facecamKey, triggerFacecamHotkey);
  }

}

function hotkeyVariants(accelerator) {
  const key = String(accelerator || '').trim();
  if (!key) return [];
  const variants = new Set([key]);
  const hasModifier = /(^|\+)(CommandOrControl|CmdOrCtrl|Control|Ctrl|Command|Cmd|Alt|Option|AltGr|Shift|Super|Meta)(\+|$)/i.test(key);
  if (!hasModifier) variants.add(`Shift+${key}`);
  const symbolFallbacks = {
    '&': '1',
    'é': '2',
    '"': '3',
    "'": '4',
    '(': '5',
    '-': '6',
    '§': '6',
    '^': '6',
    'è': '7',
    '_': '8',
    'ç': '9',
    'à': '0',
  };
  const fallback = symbolFallbacks[key];
  if (!hasModifier && fallback) {
    variants.add(fallback);
    variants.add(`Shift+${fallback}`);
  }
  return [...variants];
}

function registerHotkeyVariants(label, accelerator, callback) {
  const variants = hotkeyVariants(accelerator);
  const registered = [];
  variants.forEach((variant) => {
    try {
      if (globalShortcut.register(variant, callback)) registered.push(variant);
    } catch (e) {
      console.error(`[hotkey] ${label} erreur ${variant}:`, e.message);
    }
  });
  if (registered.length) console.log(`[hotkey] ${label} enregistré:`, registered.join(', '));
  else console.error(`[hotkey] ${label} indisponible:`, accelerator);
}

function chaseAction(command) {
  const music = selectedChaseMusic();
  return {
    action: enrichChaseAction({
      type: 'chase-control',
      command,
      id: 'local-hotkey',
      durationSeconds: Math.min(180, Math.max(5, Number(store.get('chaseDuration')) || 60)),
      label: 'CHASE',
      music: music?.url ? {
        url: music.url,
        trackId: music.id !== 'manual' ? music.id : null,
        name: music.name || null,
        startSeconds: Math.min(600, Math.max(0, Number(store.get('chaseMusicStart')) || 0)),
      } : null,
    }),
    positionX: 0,
    positionY: 0,
  };
}

function listChaseSfx(dir = store.get('chaseSfxDir')) {
  if (!dir) return null;
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map(entry => ({
        name: entry.name,
        sourcePath: path.join(dir, entry.name),
        url: pathToFileURL(path.join(dir, entry.name)).toString(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) return null;
    const start = files.find(file => /\bman\b/i.test(file.name)) || files[0];
    const end = files.find(file => /beautiful|coming.*end/i.test(file.name)) || null;
    const checkpoints = files.filter(file => file.url !== start.url && file.url !== end?.url);
    return { start, end, checkpoints: checkpoints.length ? checkpoints : files.filter(file => file.url !== end?.url) };
  } catch (e) {
    console.warn('[chase] sfx folder unavailable:', e.message);
    return null;
  }
}

function selectedChaseMusic() {
  const mode = store.get('chaseMusicMode') || 'manual';
  const library = Array.isArray(store.get('chaseMusicLibrary')) ? store.get('chaseMusicLibrary') : [];
  if (mode === 'random' && library.length) {
    return library[Math.floor(Math.random() * library.length)];
  }
  if (mode === 'library') {
    const selected = library.find(track => track.id === store.get('chaseSelectedMusicId'));
    if (selected) return selected;
  }
  const manualUrl = store.get('chaseMusicUrl') || '';
  return manualUrl ? {
    id: 'manual',
    name: 'Manual URL',
    url: manualUrl,
    sourcePath: localAudioPath(manualUrl),
  } : null;
}

function enrichChaseAction(action) {
  if (!action || !['chase-control', 'chase-timer'].includes(action.type)) return action;
  const preparedSfx = store.get('chaseSfxPrepared');
  return {
    ...action,
    checkpointSfxEnabled: store.get('chaseCheckpointSfxEnabled') !== false,
    checkpointSeconds: Math.min(180, Math.max(5, Number(store.get('chaseCheckpointSeconds')) || 30)),
    sfx: action.sfx || preparedSfx || listChaseSfx(),
  };
}

function localAudioPath(url) {
  if (!url || !String(url).startsWith('file:')) return null;
  try {
    const filePath = fileURLToPath(url);
    const ext = path.extname(filePath).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) return null;
    return filePath;
  } catch {
    return null;
  }
}

async function uploadChaseAudioUrl(url) {
  const filePath = localAudioPath(url);
  if (!filePath) return url;
  const stat = fs.statSync(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = uploadedChaseAudio.get(cacheKey);
  if (cached) return cached;
  const ext = path.extname(filePath).toLowerCase();
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  const res = await fetch(`${serverUrl}/api/upload-audio`, {
    method: 'POST',
    headers: {
      'Content-Type': AUDIO_MIME[ext] || 'audio/mpeg',
      'X-File-Name': path.basename(filePath),
      'X-MemeDrop-Persistent': 'chase',
    },
    body: fs.readFileSync(filePath),
  });
  const data = await res.json();
  if (!res.ok || !data.url) throw new Error(data.error || `audio upload failed: ${res.status}`);
  uploadedChaseAudio.set(cacheKey, data.url);
  return data.url;
}

async function uploadChaseAudioPath(filePath) {
  return uploadChaseAudioUrl(pathToFileURL(filePath).toString());
}

async function uploadChaseLibraryAudio(filePath, endpoint, extraHeaders = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  const res = await fetch(`${serverUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': AUDIO_MIME[ext] || 'audio/mpeg',
      'X-File-Name': path.basename(filePath),
      ...extraHeaders,
    },
    body: fs.readFileSync(filePath),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `upload failed: ${res.status}`);
  return data;
}

async function fetchChaseAudioLibrary() {
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  const res = await fetch(`${serverUrl}/api/chase-audio`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `library failed: ${res.status}`);
  return data;
}

async function authRequest(pathname, options = {}) {
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  const token = store.get('authToken') || '';
  const res = await fetch(`${serverUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `auth failed: ${res.status}`);
  return data;
}

async function refreshStoredAuthSession() {
  const token = store.get('authToken') || '';
  const cached = store.get('authUser') || null;
  if (!token) {
    store.set('authUser', null);
    return { ok: false, user: null };
  }
  try {
    const result = await authRequest('/api/auth/me');
    store.set('authUser', result.user || cached);
    if (result.user?.username) store.set('discordUsername', result.user.username);
    return { ok: true, user: result.user || cached };
  } catch (err) {
    store.set({ authToken: '', authUser: null });
    return { ok: false, user: null, error: err.message };
  }
}

async function initializeAuthenticatedServices() {
  registerHotkey();
  const status = await refreshStoredAuthSession();
  if (status.ok) {
    connectSocket();
    registerHotkey();
  } else {
    setLoggedOutState();
  }
}

async function submitChaseScore(durationMs) {
  try {
    return await authRequest('/api/chase-leaderboard/score', {
      method: 'POST',
      body: JSON.stringify({ durationMs: Math.max(0, Math.floor(durationMs || 0)) }),
    });
  } catch (err) {
    console.warn('[chase] leaderboard score failed:', err.message);
    return { error: err.message };
  }
}

async function refreshPreparedTrack(track) {
  if (!track?.sourcePath || !fs.existsSync(track.sourcePath)) return track;
  const stat = fs.statSync(track.sourcePath);
  const uploadedAt = Number(track.uploadedAt) || 0;
  if (track.url && track.size === stat.size && track.mtimeMs === stat.mtimeMs && Date.now() - uploadedAt < 30 * 24 * 60 * 60 * 1000) {
    return track;
  }
  const url = await uploadChaseAudioPath(track.sourcePath);
  return {
    ...track,
    url,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    uploadedAt: Date.now(),
  };
}

async function prepareSfxLibrary(sfx) {
  if (!sfx) return null;
  const clone = {
    start: sfx.start ? { ...sfx.start } : sfx.start,
    end: sfx.end ? { ...sfx.end } : sfx.end,
    checkpoints: Array.isArray(sfx.checkpoints) ? sfx.checkpoints.map(item => ({ ...item })) : [],
  };
  const items = [clone.start, clone.end, ...clone.checkpoints].filter(Boolean);
  for (const item of items) {
    if (item.sourcePath && fs.existsSync(item.sourcePath)) {
      const stat = fs.statSync(item.sourcePath);
      const uploadedAt = Number(item.uploadedAt) || 0;
      if (!item.url || item.size !== stat.size || item.mtimeMs !== stat.mtimeMs || Date.now() - uploadedAt >= 30 * 24 * 60 * 60 * 1000) {
        item.url = await uploadChaseAudioPath(item.sourcePath);
        item.size = stat.size;
        item.mtimeMs = stat.mtimeMs;
        item.uploadedAt = Date.now();
      }
    } else if (item.url) {
      item.url = await uploadChaseAudioUrl(item.url);
    }
  }
  return clone;
}

async function prepareChaseActionForBroadcast(action) {
  const prepared = enrichChaseAction(action);
  if (!prepared || prepared.command === 'stop') return prepared;
  const clone = {
    ...prepared,
    music: prepared.music ? { ...prepared.music } : prepared.music,
    sfx: prepared.sfx ? {
      start: prepared.sfx.start ? { ...prepared.sfx.start } : prepared.sfx.start,
      end: prepared.sfx.end ? { ...prepared.sfx.end } : prepared.sfx.end,
      checkpoints: Array.isArray(prepared.sfx.checkpoints)
        ? prepared.sfx.checkpoints.map(sfx => ({ ...sfx }))
        : prepared.sfx.checkpoints,
    } : prepared.sfx,
  };
  if (clone.music?.trackId) {
    const library = Array.isArray(store.get('chaseMusicLibrary')) ? store.get('chaseMusicLibrary') : [];
    const track = library.find(item => item.id === clone.music.trackId);
    if (track) {
      clone.music.url = track.url;
      clone.music.name = track.name;
    }
  }
  if (clone.music?.url) clone.music.url = await uploadChaseAudioUrl(clone.music.url);
  const sfxItems = [
    clone.sfx?.start,
    clone.sfx?.end,
    ...(Array.isArray(clone.sfx?.checkpoints) ? clone.sfx.checkpoints : []),
  ].filter(Boolean);
  for (const sfx of sfxItems) {
    if (sfx.url) sfx.url = await uploadChaseAudioUrl(sfx.url);
  }
  if (clone.sfx) {
    clone.sfx = await prepareSfxLibrary(clone.sfx);
    if (!action.sfx && clone.sfx) store.set('chaseSfxPrepared', clone.sfx);
  }
  return clone;
}

async function sendChase(command) {
  try {
    return await postDrop(chaseAction(command));
  } catch (err) {
    console.error('[chase] broadcast failed:', err.message);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('drop', chaseAction(command));
      return { ok: true, local: true };
    }
    return { error: err.message };
  }
}

function triggerChaseHotkey() {
  if (!hasAuthSession()) return;
  if (store.get('chaseTriggerMode') === 'toggle') {
    triggerChaseToggleHotkey();
    return;
  }
  if (!chaseHotkeyActive) {
    chaseHotkeyActive = true;
    chaseHotkeyRepeatSeen = false;
    chaseHotkeyStartedAt = Date.now();
    sendChase('start');
  } else {
    chaseHotkeyRepeatSeen = true;
  }
  if (chaseHotkeyTimer) clearTimeout(chaseHotkeyTimer);
  const releaseGraceMs = chaseHotkeyRepeatSeen ? 380 : 950;
  chaseHotkeyTimer = setTimeout(() => {
    chaseHotkeyActive = false;
    chaseHotkeyRepeatSeen = false;
    chaseHotkeyTimer = null;
    if (chaseHotkeyStartedAt) submitChaseScore(Date.now() - chaseHotkeyStartedAt);
    chaseHotkeyStartedAt = null;
    sendChase('stop');
  }, releaseGraceMs);
}

function triggerChaseToggleHotkey() {
  if (!hasAuthSession()) return;
  if (chaseToggleHotkeyLocked) {
    if (chaseToggleHotkeyTimer) clearTimeout(chaseToggleHotkeyTimer);
    chaseToggleHotkeyTimer = setTimeout(() => {
      chaseToggleHotkeyLocked = false;
      chaseToggleHotkeyTimer = null;
    }, 450);
    return;
  }
  chaseToggleHotkeyLocked = true;
  chaseToggleActive = !chaseToggleActive;
  if (chaseToggleActive) chaseToggleStartedAt = Date.now();
  else if (chaseToggleStartedAt) {
    submitChaseScore(Date.now() - chaseToggleStartedAt);
    chaseToggleStartedAt = null;
  }
  sendChase(chaseToggleActive ? 'start' : 'stop');
  if (chaseToggleAutoTimer) {
    clearTimeout(chaseToggleAutoTimer);
    chaseToggleAutoTimer = null;
  }
  if (chaseToggleActive) {
    const durationMs = Math.min(180, Math.max(5, Number(store.get('chaseDuration')) || 60)) * 1000;
    chaseToggleAutoTimer = setTimeout(() => {
      if (chaseToggleStartedAt) submitChaseScore(Date.now() - chaseToggleStartedAt);
      chaseToggleStartedAt = null;
      chaseToggleActive = false;
      chaseToggleAutoTimer = null;
      sendChase('stop');
    }, durationMs + 1000);
  }
  if (chaseToggleHotkeyTimer) clearTimeout(chaseToggleHotkeyTimer);
  chaseToggleHotkeyTimer = setTimeout(() => {
    chaseToggleHotkeyLocked = false;
    chaseToggleHotkeyTimer = null;
  }, 450);
}

function facecamPayload(extra = {}) {
  const width = Math.min(360, Math.max(120, Number(store.get('facecamWidth')) || 220));
  return {
    id: facecamSessionId,
    target: null,
    from: store.get('discordUsername') || 'me',
    positionX: Math.min(100, Math.max(0, Number(store.get('facecamPositionX')) || 78)),
    positionY: Math.min(100, Math.max(0, Number(store.get('facecamPositionY')) || 8)),
    width,
    height: Math.round(width * 0.75),
    ...extra,
  };
}

function startFacecam() {
  if (!hasAuthSession()) return;
  if (facecamSessionId) return;
  facecamSessionId = `facecam-${Date.now()}`;
  lastFacecamFrameAt = 0;
  const payload = facecamPayload();
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('facecam-start', payload);
  if (socketClient) socketClient.emit('facecam-start', payload);
  const win = createFacecamWindow();
  const startCapture = () => {
    if (!facecamWindow || facecamWindow.isDestroyed()) return;
    facecamWindow.webContents.send('facecam-capture-start', {
      deviceId: store.get('facecamDeviceId') || '',
      fps: Math.min(10, Math.max(2, Number(store.get('facecamFps')) || 6)),
      width: payload.width,
      height: payload.height,
    });
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', startCapture);
  else startCapture();
}

function stopFacecam() {
  if (!facecamSessionId) return;
  const id = facecamSessionId;
  facecamSessionId = null;
  if (facecamWindow && !facecamWindow.isDestroyed()) {
    facecamWindow.webContents.send('facecam-capture-stop');
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('facecam-stop', { id });
  }
  if (socketClient) socketClient.emit('facecam-stop', { id });
}

function triggerFacecamHotkey() {
  if (!hasAuthSession()) return;
  if (store.get('facecamTriggerMode') === 'toggle') {
    triggerFacecamToggleHotkey();
    return;
  }
  if (!facecamHotkeyActive) {
    facecamHotkeyActive = true;
    facecamHotkeyRepeatSeen = false;
    startFacecam();
  } else {
    facecamHotkeyRepeatSeen = true;
  }
  if (facecamHotkeyTimer) clearTimeout(facecamHotkeyTimer);
  const releaseGraceMs = facecamHotkeyRepeatSeen ? 380 : 950;
  facecamHotkeyTimer = setTimeout(() => {
    facecamHotkeyActive = false;
    facecamHotkeyRepeatSeen = false;
    facecamHotkeyTimer = null;
    stopFacecam();
  }, releaseGraceMs);
}

function triggerFacecamToggleHotkey() {
  if (!hasAuthSession()) return;
  if (facecamToggleHotkeyLocked) {
    if (facecamToggleHotkeyTimer) clearTimeout(facecamToggleHotkeyTimer);
    facecamToggleHotkeyTimer = setTimeout(() => {
      facecamToggleHotkeyLocked = false;
      facecamToggleHotkeyTimer = null;
    }, 450);
    return;
  }
  facecamToggleHotkeyLocked = true;
  if (facecamSessionId) stopFacecam();
  else startFacecam();
  if (facecamToggleHotkeyTimer) clearTimeout(facecamToggleHotkeyTimer);
  facecamToggleHotkeyTimer = setTimeout(() => {
    facecamToggleHotkeyLocked = false;
    facecamToggleHotkeyTimer = null;
  }, 450);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => store.store);

ipcMain.handle('save-settings', (_event, newSettings) => {
  const previous = { ...store.store };
  store.set(newSettings);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('settings-changed', store.store);
    if (newSettings.chaseEnabled === false) {
      clearChaseState({ broadcastStop: true });
    }
    if (newSettings.facecamEnabled === false) {
      facecamHotkeyActive = false;
      if (facecamHotkeyTimer) clearTimeout(facecamHotkeyTimer);
      if (facecamToggleHotkeyTimer) clearTimeout(facecamToggleHotkeyTimer);
      facecamHotkeyTimer = null;
      facecamToggleHotkeyTimer = null;
      facecamToggleHotkeyLocked = false;
      stopFacecam();
    }
  }
  const reconnectKeys = ['serverUrl', 'discordUsername'];
  if (reconnectKeys.some(key => Object.prototype.hasOwnProperty.call(newSettings, key) && previous[key] !== store.get(key))) {
    connectSocket();
  }
  const hotkeyKeys = ['snipHotkey', 'chaseEnabled', 'chaseHotkey', 'chaseTriggerMode', 'facecamEnabled', 'facecamHotkey', 'facecamTriggerMode'];
  if (hotkeyKeys.some(key => Object.prototype.hasOwnProperty.call(newSettings, key) && previous[key] !== store.get(key))) {
    registerHotkey();
  }
  return store.store;
});

ipcMain.on('facecam-frame', (_event, image) => {
  if (!hasAuthSession()) return;
  if (!facecamSessionId || !image) return;
  const frame = String(image);
  if (frame.length > 260000) return;
  const now = Date.now();
  const fps = Math.min(10, Math.max(2, Number(store.get('facecamFps')) || 6));
  if (now - lastFacecamFrameAt < Math.floor(1000 / fps)) return;
  lastFacecamFrameAt = now;
  const payload = facecamPayload({ image: frame });
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('facecam-frame', payload);
  if (socketClient) socketClient.emit('facecam-frame', payload);
});

ipcMain.on('facecam-status', (_event, status) => {
  sendToSender('facecam-status', status);
});

ipcMain.handle('preview-facecam-start', () => {
  startFacecam();
  return { ok: true };
});

ipcMain.handle('preview-facecam-stop', () => {
  stopFacecam();
  return { ok: true };
});

ipcMain.handle('get-facecam-devices', async () => {
  try {
    return { devices: await listFacecamDevices() };
  } catch (err) {
    console.error('[facecam] device list failed:', err.message);
    return { devices: [], error: err.message };
  }
});

// Settings lives in the sender now (as a tab) — route old callers there.
ipcMain.on('open-settings', () => openSenderTab('settings'));

// ── Sender — drop direct sans Discord ────────────────────────────────────────

// Resolve a pasted URL into a playable media object { type, url }.
// TikTok/Twitter resolve to a direct video when possible; otherwise embed.
async function resolveMedia(url) {
  if (!url || !url.trim()) return null;
  const clean = url.trim();
  const medalMatch = clean.match(/^https?:\/\/(?:www\.)?medal\.tv\/(?:games\/[^/?#]+\/)?clips?\/[\w-]+/i);
  const tiktokMatch  = clean.match(/tiktok\.com\/@[\w.]+\/video\/(\d+)/);
  const twitterMatch = clean.match(/(?:twitter\.com|x\.com)\/([\w]+)\/status\/(\d+)/);
  const youtubeMatch = clean.match(/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([\w-]+)/);
  let media = null;

  if (medalMatch) {
    const r = await fetch(clean, { headers: { 'User-Agent': 'Mozilla/5.0 MemeDrop' } });
    if (!r.ok) throw new Error(`Medal returned ${r.status}`);
    const html = await r.text();
    const meta = html.match(/<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::secure_url)?|twitter:player:stream)["']/i);
    if (!meta?.[1]) throw new Error('This Medal clip is private or unavailable');
    media = { type: 'video', url: meta[1].replace(/&amp;/g, '&') };

  } else if (tiktokMatch) {
    try {
      const r = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(clean)}`);
      const j = await r.json();
      if (j.code === 0 && j.data?.play) media = { type: 'video', url: j.data.play };
    } catch(e) {}
    if (!media) media = { type: 'tiktok', url: `https://www.tiktok.com/embed/v2/${tiktokMatch[1]}` };

  } else if (twitterMatch) {
    try {
      const [, username, tweetId] = twitterMatch;
      const r = await fetch(`https://api.fxtwitter.com/${username}/status/${tweetId}`);
      const j = await r.json();
      const videos = j.tweet?.media?.videos || [];
      const best   = videos.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      if (best?.url) {
        media = { type: 'video', url: best.url };
      } else {
        const photo = (j.tweet?.media?.photos || [])[0];
        if (photo?.url) media = { type: 'image', url: photo.url };
      }
    } catch(e) {}
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

// Resolve a pasted link (TikTok/Twitter → direct seekable mp4 when possible) so
// the sender can scrub it in the trim timeline without downloading anything.
ipcMain.handle('resolve-link', async (_event, url) => {
  try { return await resolveMedia(url); }
  catch (err) { return { error: err.message }; }
});

// Resolve media + POST it to /api/drop from the Compose workspace.
async function postDrop({ url, target, caption, captionTop, captionBottom, captionStyle, effects, audioUrl, fadeInDuration, fadeOutDuration, loop, loopDuration, loopTimes, trimStart, trimEnd, size, positionX, positionY, action }) {
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;

  const media = url ? await resolveMedia(url) : null;

  const event = {
    media,
    from:         store.get('discordUsername') || null,
    audio:        audioUrl ? { type: 'voice', url: audioUrl } : null,
    effects:      effects || [],
    target:       target  || null,
    caption:      caption || null,
    captionTop:   captionTop    || null,
    captionBottom: captionBottom || null,
    captionStyle: captionStyle === 'card' ? 'card' : 'overlay',
    fadeInDuration: fadeInDuration ?? null,
    fadeOutDuration: fadeOutDuration ?? null,
    loop:         loop    ?? false,
    loopDuration: loopDuration || null,
    loopTimes:    loopTimes || null,
    trimStart:    trimStart ?? null,
    trimEnd:      trimEnd ?? null,
    size:         size    || 'm',
    positionX:    positionX ?? null,
    positionY:    positionY ?? null,
    action:       await prepareChaseActionForBroadcast(action) || null,
  };

  const res = await fetch(`${serverUrl}/api/drop`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(event),
  });

  return res.json();
}

ipcMain.handle('send-drop', async (_event, payload) => {
  try {
    return await postDrop(payload);
  } catch (err) {
    console.error('[sender] erreur drop:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('upload-audio', async (_event, audioBuffer) => {
  try {
    const serverUrl = store.get('serverUrl') || 'https://memelord-production-3bbf.up.railway.app';

    const res = await fetch(`${serverUrl}/api/upload-audio`, {
      method:  'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body:    Buffer.from(audioBuffer),
    });

    return res.json();
  } catch (err) {
    console.error('[sender] erreur upload audio:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('upload-media', async (_event, { buffer, mimeType }) => {
  try {
    const serverUrl = store.get('serverUrl') || 'https://memelord-production-3bbf.up.railway.app';
    const res = await fetch(`${serverUrl}/api/upload-media`, {
      method:  'POST',
      headers: { 'Content-Type': mimeType },
      body:    Buffer.from(buffer),
    });
    return res.json();
  } catch (err) {
    console.error('[sender] erreur upload media:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('get-users', async () => {
  try {
    const serverUrl = store.get('serverUrl') || 'https://memelord-production-3bbf.up.railway.app';
    const res = await fetch(`${serverUrl}/api/users`);
    return res.json();
  } catch (err) {
    return { users: [], error: err.message };
  }
});

ipcMain.handle('preview-drop', async (_event, payload) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const event = payload?.action ? { ...payload, action: enrichChaseAction(payload.action) } : payload;
    overlayWindow.webContents.send('drop', event);
    return { ok: true, local: true };
  }
  return { error: 'overlay unavailable' };
});

ipcMain.handle('choose-chase-audio', async () => {
  const result = await dialog.showOpenDialog(senderWindow || undefined, {
    title: 'Choose chase music',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'webm'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const tracks = [];
  for (const filePath of result.filePaths) {
    const result = await uploadChaseLibraryAudio(filePath, '/api/chase-audio/music');
    if (result.entry) tracks.push(result.entry);
  }
  if (tracks[0]) store.set('chaseMusicMode', 'library');
  const library = await fetchChaseAudioLibrary();
  store.set('chaseMusicLibrary', library.music || []);
  if (tracks[0]) store.set('chaseSelectedMusicId', tracks[0].id);
  return { tracks, library: library.music || [] };
});

ipcMain.handle('choose-chase-sfx-folder', async () => {
  const result = await dialog.showOpenDialog(senderWindow || undefined, {
    title: 'Choose chase SFX folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const dir = result.filePaths[0];
  const sfx = listChaseSfx(dir);
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  await fetch(`${serverUrl}/api/chase-audio/sfx-reset`, { method: 'POST' });
  const uploads = [];
  if (sfx?.start?.sourcePath) uploads.push(uploadChaseLibraryAudio(sfx.start.sourcePath, '/api/chase-audio/sfx', { 'X-MemeDrop-Sfx-Role': 'start' }));
  if (sfx?.end?.sourcePath) uploads.push(uploadChaseLibraryAudio(sfx.end.sourcePath, '/api/chase-audio/sfx', { 'X-MemeDrop-Sfx-Role': 'end' }));
  for (const checkpoint of sfx?.checkpoints || []) {
    if (checkpoint.sourcePath) uploads.push(uploadChaseLibraryAudio(checkpoint.sourcePath, '/api/chase-audio/sfx', { 'X-MemeDrop-Sfx-Role': 'checkpoint' }));
  }
  await Promise.all(uploads);
  const library = await fetchChaseAudioLibrary();
  store.set({ chaseSfxDir: dir, chaseSfxPrepared: library.sfx || null });
  return { dir, sfx: library.sfx || null };
});

ipcMain.handle('get-chase-audio-library', async () => {
  try {
    const library = await fetchChaseAudioLibrary();
    store.set({ chaseMusicLibrary: library.music || [], chaseSfxPrepared: library.sfx || null });
    return library;
  } catch (err) {
    return { music: [], sfx: { start: null, end: null, checkpoints: [] }, error: err.message };
  }
});

ipcMain.handle('create-chase-playlist', async (_event, name) => {
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  const res = await fetch(`${serverUrl}/api/chase-audio/playlists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  store.set('chaseMusicLibrary', body.library?.music || []);
  return { ok: true, library: body.library || { music: [], playlists: [] }, playlist: body.playlist };
});

ipcMain.handle('delete-chase-playlist', async (_event, id) => {
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  const res = await fetch(`${serverUrl}/api/chase-audio/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  store.set('chaseMusicLibrary', body.library?.music || []);
  return { ok: true, library: body.library || { music: [], playlists: [] } };
});

ipcMain.handle('move-chase-music-to-playlist', async (_event, { trackId, playlistId }) => {
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  const res = await fetch(`${serverUrl}/api/chase-audio/music/${encodeURIComponent(trackId)}/playlist`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlistId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  store.set('chaseMusicLibrary', body.library?.music || []);
  return { ok: true, library: body.library || { music: [], playlists: [] } };
});

ipcMain.handle('delete-chase-music', async (_event, id) => {
  const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
  const res = await fetch(`${serverUrl}/api/chase-audio/music/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  store.set('chaseMusicLibrary', body.library?.music || []);
  if (store.get('chaseSelectedMusicId') === id) {
    store.set('chaseSelectedMusicId', body.library?.music?.[0]?.id || '');
  }
  return { ok: true, library: body.library || { music: [] } };
});

ipcMain.handle('auth-status', async () => {
  const status = await refreshStoredAuthSession();
  if (!status.ok) {
    setLoggedOutState();
  }
  return status;
});

ipcMain.handle('auth-register', async (_event, { username, password }) => {
  try {
    const result = await authRequest('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    store.set({ authToken: result.token || '', authUser: result.user || null, discordUsername: result.user?.username || username || '' });
    connectSocket();
    registerHotkey();
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth-login', async (_event, { username, password }) => {
  try {
    const result = await authRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    store.set({ authToken: result.token || '', authUser: result.user || null, discordUsername: result.user?.username || username || '' });
    connectSocket();
    registerHotkey();
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth-logout', () => {
  store.set({ authToken: '', authUser: null });
  setLoggedOutState();
  return { ok: true };
});

ipcMain.handle('get-chase-leaderboard', async () => {
  try {
    const result = await authRequest('/api/chase-leaderboard');
    return { leaderboard: result.leaderboard };
  } catch (err) {
    return { leaderboard: null, error: err.message };
  }
});

ipcMain.handle('submit-chase-score', async (_event, durationMs) => {
  const result = await submitChaseScore(durationMs);
  return result || { skipped: true };
});

ipcMain.on('close-sender', () => {
  if (senderWindow && !senderWindow.isDestroyed()) senderWindow.close();
});

ipcMain.on('minimize-sender', () => {
  if (senderWindow && !senderWindow.isDestroyed()) senderWindow.minimize();
});

// Launch the Windows region snip overlay; the user pastes the result back into
// Compose (Ctrl+V). Phase 2 will capture+crop in-app via a global hotkey.
ipcMain.handle('open-snip-tool', async () => {
  try { await shell.openExternal('ms-screenclip:'); return { ok: true }; }
  catch (err) { return { error: err.message }; }
});

// ── Clip library ──────────────────────────────────────────────────────────────

function getLibrary() { return store.get('library') || []; }

ipcMain.handle('library-list', () => getLibrary());

// Save a clip from a pasted URL: resolve → download the bytes → store on disk.
ipcMain.handle('library-save', async (_e, { url, name, situation }) => {
  try {
    const media = await resolveMedia(url);
    if (!media || media.type !== 'video') {
      return { error: 'Only direct videos, TikTok or Twitter clips can be saved' };
    }
    const r = await fetch(media.url);
    if (!r.ok) return { error: `download failed (${r.status})` };
    const buf = Buffer.from(await r.arrayBuffer());
    const id = Date.now().toString();
    const file = `${id}.mp4`;
    fs.writeFileSync(path.join(clipsDir, file), buf);
    const entry = { id, file, name: (name || 'Clip').slice(0, 60), situation: situation || 'w', createdAt: Date.now() };
    const lib = getLibrary(); lib.unshift(entry); store.set('library', lib);
    return { ok: true, entry };
  } catch (err) {
    console.error('[library] save error:', err.message);
    return { error: err.message };
  }
});

// Save a clip from raw bytes (e.g. a dragged-in file).
ipcMain.handle('library-save-buffer', async (_e, { buffer, name, situation }) => {
  try {
    const id = Date.now().toString();
    const file = `${id}.mp4`;
    fs.writeFileSync(path.join(clipsDir, file), Buffer.from(buffer));
    const entry = { id, file, name: (name || 'Clip').slice(0, 60), situation: situation || 'w', createdAt: Date.now() };
    const lib = getLibrary(); lib.unshift(entry); store.set('library', lib);
    return { ok: true, entry };
  } catch (err) {
    console.error('[library] save-buffer error:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('library-rename', (_e, { id, name }) => {
  const lib = getLibrary();
  const entry = lib.find(x => x.id === id);
  if (entry) { entry.name = (name || 'Clip').slice(0, 60); store.set('library', lib); }
  return lib;
});

ipcMain.handle('library-delete', (_e, id) => {
  const lib = getLibrary();
  const entry = lib.find(x => x.id === id);
  if (entry) { try { fs.unlinkSync(path.join(clipsDir, entry.file)); } catch {} }
  clipUploadCache.delete(id);
  const next = lib.filter(x => x.id !== id);
  store.set('library', next);
  return next;
});

// Upload a saved clip to the server so it can be dropped (returns { url }).
ipcMain.handle('library-upload', async (_e, id) => {
  try {
    return await uploadLibraryClip(id);
  } catch (err) {
    console.error('[library] upload error:', err.message);
    return { error: err.message };
  }
});

// ── Favorites ─────────────────────────────────────────────────────────────────

ipcMain.handle('get-favorites', () => store.get('favorites') || []);

ipcMain.handle('save-favorite', (_e, fav) => {
  const favs = store.get('favorites') || [];
  favs.push({ ...fav, id: Date.now() });
  store.set('favorites', favs);
  return favs;
});

ipcMain.handle('delete-favorite', (_e, id) => {
  const favs = (store.get('favorites') || []).filter(f => f.id !== id);
  store.set('favorites', favs);
  return favs;
});

// ── History ───────────────────────────────────────────────────────────────────

ipcMain.on('save-history', (_event, entry) => {
  const history = store.get('history') || [];
  history.unshift(entry);
  store.set('history', history.slice(0, 50));
});

ipcMain.handle('get-history', () => store.get('history') || []);

ipcMain.handle('clear-history', () => {
  store.set('history', []);
  return [];
});

// Fetch TTS audio (Google Translate / tetyys SAPI4) with a browser UA and return
// it as a data URL the overlay can play. Free, no key.
ipcMain.handle('tts-fetch', async (_e, url) => {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
    });
    if (!res.ok) return { error: `tts ${res.status}` };
    const buf  = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || 'audio/mpeg';
    return { dataUrl: `data:${type};base64,${buf.toString('base64')}` };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('check-for-updates', () => {
  if (!app.isPackaged) {
    return { status: 'dev' };
  }
  autoUpdater.checkForUpdates().catch(err => {
    sendUpdateStatus(`❌ ${err.message}`);
  });
  return { checking: true };
});

// ── App ───────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Autoriser l'accès au micro (pour le sender window)
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  // Serve saved library clips to the sender via clip://<file>
  protocol.registerFileProtocol('clip', (request, callback) => {
    const file = path.basename(decodeURIComponent(request.url.replace(/^clip:\/\//, '')));
    callback(path.join(clipsDir, file));
  });

  createOverlayWindow();
  initializeAuthenticatedServices();
  if (!app.isPackaged && process.argv.includes('--show-sender')) createSenderWindow();

  // Vérifier les mises à jour (seulement en production, pas en dev)
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify();

  // Tray icon (the real app icon, resized for the Windows notification area).
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Send Drop',  click: () => createSenderWindow()      },
    { label: 'Settings',   click: () => openSenderTab('settings') },
    { type: 'separator' },
    { label: 'Quitter',    click: () => app.quit()                },
  ]);
  tray.setToolTip('MemeDrop');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => createSenderWindow()); // clic gauche → sender
  tray.on('double-click', () => openSenderTab('settings'));
});

// ── Auto-update ───────────────────────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdateStatus(msg) {
  // Settings (incl. "check for updates") is now a tab in the sender window.
  if (senderWindow && !senderWindow.isDestroyed()) {
    senderWindow.webContents.send('update-status', msg);
  }
}

autoUpdater.on('checking-for-update',  ()     => sendUpdateStatus('⏳ Checking for updates…'));
autoUpdater.on('update-not-available', ()     => sendUpdateStatus(`✅ Already on latest version (v${app.getVersion()})`));
autoUpdater.on('update-available',     (info) => sendUpdateStatus(`🔄 Update found: v${info.version} — downloading…`));
autoUpdater.on('download-progress',    (p)    => sendUpdateStatus(`⬇️ Downloading… ${Math.round(p.percent)}%`));
autoUpdater.on('error',                (err)  => sendUpdateStatus(`❌ Error: ${err.message}`));
autoUpdater.on('update-downloaded', () => {
  sendUpdateStatus('✅ Update downloaded — restarting in 2s…');
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 2000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => e.preventDefault()); // garder en tray

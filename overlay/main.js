const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut, session, protocol, shell, desktopCapturer, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const { io } = require('socket.io-client');

const store = new Store({
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
    snipHotkey: 'CommandOrControl+Shift+S',
    chaseHotkey: '6',
    chaseDuration: 60,
    chaseMusicUrl: 'https://youtu.be/N_og7Lok8j8',
    chaseMusicStart: 10,
  },
});

// Removed product surfaces: discard obsolete local configuration left by older builds.
store.delete('deck');
store.delete('giphyApiKey');

// Local clip library — durable reaction clips saved to disk
const clipsDir = path.join(app.getPath('userData'), 'clips');
try { fs.mkdirSync(clipsDir, { recursive: true }); } catch {}

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
let tray             = null;
let socketClient     = null;
let overlayRaiseTimer = null;
let chaseHotkeyActive = false;
let chaseHotkeyTimer = null;

// Only allow one production MemeDrop at a time. Development can opt into a
// separate visual-test instance without closing the user's installed app.
const allowDevInstance = !app.isPackaged && process.argv.includes('--dev-multiple');
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
  if (!settings.serverUrl || !settings.discordUsername) return;

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

  const chaseKey = store.get('chaseHotkey');
  if (chaseKey) {
    try {
      const ok = globalShortcut.register(chaseKey, triggerChaseHotkey);
      if (ok) console.log('[hotkey] chase enregistré:', chaseKey);
      else console.error('[hotkey] chase indisponible:', chaseKey);
    } catch (e) {
      console.error('[hotkey] chase erreur:', e.message);
    }
  }

}

function chaseAction(command) {
  const musicUrl = store.get('chaseMusicUrl') || '';
  return {
    action: {
      type: 'chase-control',
      command,
      id: 'local-hotkey',
      durationSeconds: Math.min(180, Math.max(5, Number(store.get('chaseDuration')) || 60)),
      label: 'CHASE',
      music: musicUrl ? {
        url: musicUrl,
        startSeconds: Math.min(600, Math.max(0, Number(store.get('chaseMusicStart')) || 0)),
      } : null,
    },
    positionX: 50,
    positionY: 14,
  };
}

function sendChaseToOverlay(command) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('drop', chaseAction(command));
}

function triggerChaseHotkey() {
  if (!chaseHotkeyActive) {
    chaseHotkeyActive = true;
    sendChaseToOverlay('start');
  }
  if (chaseHotkeyTimer) clearTimeout(chaseHotkeyTimer);
  chaseHotkeyTimer = setTimeout(() => {
    chaseHotkeyActive = false;
    chaseHotkeyTimer = null;
    sendChaseToOverlay('stop');
  }, 360);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => store.store);

ipcMain.handle('save-settings', (_event, newSettings) => {
  store.set(newSettings);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('settings-changed', store.store);
  }
  connectSocket();
  registerHotkey();
  return store.store;
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
    action:       action || null,
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
    overlayWindow.webContents.send('drop', payload);
    return { ok: true, local: true };
  }
  return { error: 'overlay unavailable' };
});

ipcMain.handle('choose-chase-audio', async () => {
  const result = await dialog.showOpenDialog(senderWindow || undefined, {
    title: 'Choose chase music',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'webm'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  return { url: pathToFileURL(result.filePaths[0]).toString(), path: result.filePaths[0] };
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
  connectSocket();
  registerHotkey();
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

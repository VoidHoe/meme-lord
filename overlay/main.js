const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut, session, protocol } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { io } = require('socket.io-client');

const store = new Store({
  defaults: {
    serverUrl: 'https://memelord-production-3bbf.up.railway.app',
    discordUsername: '',
    positionX: 50,
    positionY: 50,
    duration: 5000,
    volumeSfx: 80,
    volumeVoice: 100,
    effects: true,
    giphyApiKey: 'AMwifjHTUcKxrxHdjcDSWqs6uLrCXCNk',
    micDeviceId: '',
    favorites: [],
    anchorPosition: 'center',
    dropSize: 'm',
    history: [],
    library: [],
  },
});

// Local clip library — durable reaction clips saved to disk
const clipsDir = path.join(app.getPath('userData'), 'clips');
try { fs.mkdirSync(clipsDir, { recursive: true }); } catch {}
const DEFAULT_SERVER = 'https://memelord-production-3bbf.up.railway.app';

// clip:// streams saved library videos into the sender (must run before app ready)
protocol.registerSchemesAsPrivileged([
  { scheme: 'clip', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

let overlayWindow    = null;
let settingsWindow   = null;
let senderWindow     = null;
let tray             = null;
let socketClient     = null;
let overlayRaiseTimer = null;

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
    width: 460,
    height: 560,
    resizable: true,
    minWidth: 420,
    minHeight: 500,
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

ipcMain.on('open-settings', createSettingsWindow);

// ── Sender — drop direct sans Discord ────────────────────────────────────────

// Resolve a pasted URL into a playable media object { type, url }.
// TikTok/Twitter resolve to a direct video when possible; otherwise embed.
async function resolveMedia(url) {
  if (!url || !url.trim()) return null;
  const clean = url.trim();
  const tiktokMatch  = clean.match(/tiktok\.com\/@[\w.]+\/video\/(\d+)/);
  const twitterMatch = clean.match(/(?:twitter\.com|x\.com)\/([\w]+)\/status\/(\d+)/);
  const youtubeMatch = clean.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
  let media = null;

  if (tiktokMatch) {
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

ipcMain.handle('send-drop', async (_event, { url, target, caption, effects, audioUrl, loop, loopDuration, loopTimes, size, positionX, positionY }) => {
  try {
    const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;

    const media = await resolveMedia(url);

    const event = {
      media,
      audio:        audioUrl ? { type: 'voice', url: audioUrl } : null,
      effects:      effects || [],
      target:       target  || null,
      caption:      caption || null,
      loop:         loop    ?? false,
      loopDuration: loopDuration || null,
      loopTimes:    loopTimes || null,
      size:         size    || 'm',
      positionX:    positionX ?? null,
      positionY:    positionY ?? null,
    };

    const res = await fetch(`${serverUrl}/api/drop`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(event),
    });

    return res.json();
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
    return { users: [] };
  }
});

ipcMain.on('close-sender', () => {
  if (senderWindow && !senderWindow.isDestroyed()) senderWindow.close();
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

ipcMain.handle('library-delete', (_e, id) => {
  const lib = getLibrary();
  const entry = lib.find(x => x.id === id);
  if (entry) { try { fs.unlinkSync(path.join(clipsDir, entry.file)); } catch {} }
  const next = lib.filter(x => x.id !== id);
  store.set('library', next);
  return next;
});

// Upload a saved clip to the server so it can be dropped (returns { url }).
ipcMain.handle('library-upload', async (_e, id) => {
  try {
    const entry = getLibrary().find(x => x.id === id);
    if (!entry) return { error: 'clip not found' };
    const buf = fs.readFileSync(path.join(clipsDir, entry.file));
    const serverUrl = store.get('serverUrl') || DEFAULT_SERVER;
    const res = await fetch(`${serverUrl}/api/upload-media`, {
      method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: buf,
    });
    return res.json();
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

// ── GIF Search (Tenor) ────────────────────────────────────────────────────────

ipcMain.handle('search-gifs', async (_e, query) => {
  const apiKey = store.get('giphyApiKey') || '';
  if (!apiKey) return { error: 'no_key' };
  try {
    const url = `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(query)}&api_key=${apiKey}&limit=12&rating=g`;
    const res  = await fetch(url);
    return res.json();
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

  // Vérifier les mises à jour (seulement en production, pas en dev)
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify();

  // Tray icon
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAMklEQVQ4jWNgGAWkAv8JMIwaMGrAqAGDxwBCBpAcQMh7lAwhZMCQC+GgAdQ2AAAGIiQAAQc63gAAAABJRU5ErkJggg=='
  );
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Send Drop',  click: createSenderWindow  },
    { label: 'Settings',   click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Quitter',    click: () => app.quit()    },
  ]);
  tray.setToolTip('MemeDrop');
  tray.setContextMenu(contextMenu);
  tray.on('click', createSenderWindow); // clic gauche → sender
  tray.on('double-click', createSettingsWindow);
});

// ── Auto-update ───────────────────────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdateStatus(msg) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('update-status', msg);
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

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
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
  },
});

let overlayWindow  = null;
let settingsWindow = null;
let senderWindow   = null;
let tray           = null;
let socketClient   = null;

// ── Fenêtres ──────────────────────────────────────────────────────────────────

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

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

  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.on('closed', () => { overlayWindow = null; });
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

ipcMain.handle('send-drop', async (_event, { url, target, caption, effects, audioUrl }) => {
  try {
    const serverUrl = store.get('serverUrl') || 'https://memelord-production-3bbf.up.railway.app';

    // Détecter le type de media depuis l'extension de l'URL
    let media = null;
    if (url && url.trim()) {
      const clean = url.trim();
      const ext = clean.split('.').pop().split('?')[0].toLowerCase();
      let type = 'image';
      if (ext === 'gif')                      type = 'gif';
      else if (['mp4', 'webm'].includes(ext)) type = 'video';
      media = { type, url: clean };
    }

    const event = {
      media,
      audio:   audioUrl ? { type: 'voice', url: audioUrl } : null,
      effects: effects || [],
      target:  target  || null,
      caption: caption || null,
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

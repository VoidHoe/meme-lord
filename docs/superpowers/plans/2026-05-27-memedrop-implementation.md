# MemeDrop Clone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows overlay app + Discord bot that affiche des mèmes, GIFs, vidéos et audio en temps réel sur les écrans des joueurs connectés.

**Architecture:** Un serveur Node.js central (Railway) reçoit les events du bot Discord et les broadcast via socket.io aux clients Electron. Chaque joueur installe l'app Electron qui affiche les drops en overlay transparent always-on-top, avec support audio (voice messages + SFX library).

**Tech Stack:** Node.js 20, discord.js v14, socket.io v4, Express v4, Electron v28, electron-store, Jest

---

## File Map

```
memedrop/
├── package.json                    # Root — npm workspaces (server + overlay)
├── .env.example                    # DISCORD_TOKEN, DISCORD_CHANNEL_ID, PORT
│
├── server/
│   ├── package.json
│   ├── index.js                    # Entry: Express + socket.io server
│   ├── bot.js                      # Discord bot — parsing + forwarding events
│   ├── router.js                   # Broadcast / targeted routing
│   ├── audioProxy.js               # Download Discord CDN files, serve public URL
│   └── sounds.js                   # Liste des SFX disponibles
│
├── server/tests/
│   ├── router.test.js
│   ├── bot.test.js
│   └── audioProxy.test.js
│
└── overlay/
    ├── package.json
    ├── main.js                     # Electron main process
    ├── preload.js                  # IPC bridge renderer ↔ main
    ├── overlay.html                # Fenêtre transparente
    ├── overlay.js                  # Queue, display, audio, effects
    ├── settings.html               # Fenêtre settings
    ├── settings.js                 # Config UI logic
    └── sounds/                     # SFX bundlés (.mp3)
        ├── airhorn.mp3
        ├── bruh.mp3
        ├── vine_boom.mp3
        ├── sad_violin.mp3
        └── gg.mp3
```

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `server/package.json`
- Create: `overlay/package.json`
- Create: `.env.example`

- [ ] **Step 1: Create root package.json avec workspaces**

```json
{
  "name": "memedrop",
  "version": "1.0.0",
  "private": true,
  "workspaces": ["server", "overlay"],
  "scripts": {
    "server": "node server/index.js",
    "overlay": "electron overlay/main.js",
    "test": "jest --testPathPattern=server/tests"
  }
}
```

- [ ] **Step 2: Créer server/package.json**

```json
{
  "name": "memedrop-server",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "test": "jest"
  },
  "dependencies": {
    "discord.js": "^14.14.1",
    "express": "^4.18.2",
    "socket.io": "^4.7.4",
    "dotenv": "^16.4.1",
    "node-fetch": "^3.3.2",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  }
}
```

- [ ] **Step 3: Créer overlay/package.json**

```json
{
  "name": "memedrop-overlay",
  "version": "1.0.0",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder --win --x64"
  },
  "dependencies": {
    "electron-store": "^8.1.0",
    "socket.io-client": "^4.7.4"
  },
  "devDependencies": {
    "electron": "^28.2.0",
    "electron-builder": "^24.9.1"
  }
}
```

- [ ] **Step 4: Créer .env.example**

```env
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CHANNEL_ID=your_channel_id_here
PORT=3000
PUBLIC_URL=https://your-app.railway.app
```

- [ ] **Step 5: Installer les dépendances**

```bash
cd T:/claude/projects/memedrop
npm install
```

Expected: `node_modules` créés dans `server/` et `overlay/`

- [ ] **Step 6: Commit**

```bash
git init
git add .
git commit -m "chore: project setup with npm workspaces"
```

---

## Task 2: Server — Router (broadcast + ciblage)

**Files:**
- Create: `server/router.js`
- Create: `server/tests/router.test.js`

- [ ] **Step 1: Écrire le test**

`server/tests/router.test.js`:
```js
const { createRouter } = require('../router');

describe('Router', () => {
  let router;
  let mockIo;
  const clientA = { id: 'sock1', discordUsername: 'Tanguy', emit: jest.fn() };
  const clientB = { id: 'sock2', discordUsername: 'Pote1', emit: jest.fn() };

  beforeEach(() => {
    mockIo = { sockets: { sockets: new Map([['sock1', clientA], ['sock2', clientB]]) } };
    router = createRouter(mockIo);
    clientA.emit.mockClear();
    clientB.emit.mockClear();
  });

  test('broadcast envoie à tous les clients', () => {
    router.dispatch({ media: { type: 'image', url: 'http://x.com/a.png' }, audio: null, effects: [], target: null });
    expect(clientA.emit).toHaveBeenCalledWith('drop', expect.objectContaining({ media: { type: 'image', url: 'http://x.com/a.png' } }));
    expect(clientB.emit).toHaveBeenCalledWith('drop', expect.any(Object));
  });

  test('ciblage envoie uniquement à la cible', () => {
    router.dispatch({ media: { type: 'emoji', url: '💀' }, audio: null, effects: [], target: 'Pote1' });
    expect(clientA.emit).not.toHaveBeenCalled();
    expect(clientB.emit).toHaveBeenCalledWith('drop', expect.objectContaining({ media: { type: 'emoji', url: '💀' } }));
  });

  test('ciblage sur username inexistant ne crash pas', () => {
    expect(() => {
      router.dispatch({ media: null, audio: { type: 'sfx', url: 'sfx:airhorn' }, effects: [], target: 'Inconnu' });
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test — vérifier qu'il échoue**

```bash
cd server && npx jest tests/router.test.js
```

Expected: FAIL — `Cannot find module '../router'`

- [ ] **Step 3: Implémenter router.js**

`server/router.js`:
```js
function createRouter(io) {
  function dispatch(event) {
    const { target } = event;
    const clients = io.sockets.sockets;

    if (!target) {
      clients.forEach(socket => {
        if (socket.discordUsername) socket.emit('drop', event);
      });
      return;
    }

    clients.forEach(socket => {
      if (socket.discordUsername === target) socket.emit('drop', event);
    });
  }

  return { dispatch };
}

module.exports = { createRouter };
```

- [ ] **Step 4: Run test — vérifier qu'il passe**

```bash
cd server && npx jest tests/router.test.js
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/router.js server/tests/router.test.js
git commit -m "feat(server): add event router with broadcast and targeting"
```

---

## Task 3: Server — Socket.io Server

**Files:**
- Create: `server/index.js`

- [ ] **Step 1: Créer server/index.js**

```js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createRouter } = require('./router');
const { startBot } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Servir les fichiers audio proxiés
app.use('/audio', express.static(path.join(__dirname, 'audio_cache')));

const router = createRouter(io);

io.on('connection', (socket) => {
  console.log(`[socket] client connecté: ${socket.id}`);

  socket.on('register', (discordUsername) => {
    socket.discordUsername = discordUsername;
    console.log(`[socket] ${discordUsername} enregistré (${socket.id})`);
  });

  socket.on('disconnect', () => {
    console.log(`[socket] ${socket.discordUsername || socket.id} déconnecté`);
  });
});

// Exposer le router au bot
app.locals.router = router;

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] écoute sur le port ${PORT}`);
  startBot(router);
});
```

- [ ] **Step 2: Test manuel — démarrer le serveur**

```bash
cd server && node index.js
```

Expected: `[server] écoute sur le port 3000` (le bot va échouer sans token, c'est normal)

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(server): add socket.io server with client registration"
```

---

## Task 4: Server — Bot Discord (parsing)

**Files:**
- Create: `server/bot.js`
- Create: `server/sounds.js`
- Create: `server/tests/bot.test.js`

- [ ] **Step 1: Créer server/sounds.js**

```js
const SOUNDS = [
  'airhorn', 'bruh', 'vine_boom', 'sad_violin', 'gg',
  'myname', 'nani', 'mlg_hit', 'wow', 'bonk'
];

function isValidSound(name) {
  return SOUNDS.includes(name.toLowerCase());
}

module.exports = { SOUNDS, isValidSound };
```

- [ ] **Step 2: Écrire les tests de parsing**

`server/tests/bot.test.js`:
```js
const { parseMessage } = require('../bot');

describe('parseMessage', () => {
  function makeMsg(overrides = {}) {
    return {
      content: '',
      attachments: new Map(),
      mentions: { users: new Map() },
      author: { bot: false },
      ...overrides,
    };
  }

  test('image attachement → media image', () => {
    const attachments = new Map([['1', { url: 'http://cdn.discord.com/a.png', contentType: 'image/png', flags: 0 }]]);
    const result = parseMessage(makeMsg({ attachments }));
    expect(result).toMatchObject({ media: { type: 'image', url: 'http://cdn.discord.com/a.png' }, audio: null, target: null });
  });

  test('GIF attachement → media gif', () => {
    const attachments = new Map([['1', { url: 'http://cdn.discord.com/a.gif', contentType: 'image/gif', flags: 0 }]]);
    const result = parseMessage(makeMsg({ attachments }));
    expect(result.media.type).toBe('gif');
  });

  test('voice message → audio voice', () => {
    // discord.js voice messages have flags = 8192 (AttachmentFlags.IsVoiceMessage)
    const attachments = new Map([['1', { url: 'http://cdn.discord.com/voice.ogg', contentType: 'audio/ogg', flags: 8192 }]]);
    const result = parseMessage(makeMsg({ attachments }));
    expect(result).toMatchObject({ media: null, audio: { type: 'voice', url: 'http://cdn.discord.com/voice.ogg' } });
  });

  test('/sound airhorn → sfx event', () => {
    const result = parseMessage(makeMsg({ content: '/sound airhorn' }));
    expect(result).toMatchObject({ media: null, audio: { type: 'sfx', url: 'sfx:airhorn' } });
  });

  test('/sound airhorn @Pote1 → sfx avec ciblage', () => {
    const users = new Map([['123', { username: 'Pote1' }]]);
    const result = parseMessage(makeMsg({ content: '/sound airhorn @Pote1', mentions: { users } }));
    expect(result).toMatchObject({ audio: { type: 'sfx', url: 'sfx:airhorn' }, target: 'Pote1' });
  });

  test('/react 💀 → emoji media', () => {
    const result = parseMessage(makeMsg({ content: '/react 💀' }));
    expect(result).toMatchObject({ media: { type: 'emoji', url: '💀' } });
  });

  test('URL YouTube → media youtube', () => {
    const result = parseMessage(makeMsg({ content: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
    expect(result).toMatchObject({ media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
  });

  test('message bot ignoré → null', () => {
    const result = parseMessage(makeMsg({ author: { bot: true } }));
    expect(result).toBeNull();
  });

  test('message texte sans commande → null', () => {
    const result = parseMessage(makeMsg({ content: 'hello les gars' }));
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests — vérifier qu'ils échouent**

```bash
cd server && npx jest tests/bot.test.js
```

Expected: FAIL — `Cannot find module '../bot'`

- [ ] **Step 4: Implémenter bot.js**

`server/bot.js`:
```js
const { Client, GatewayIntentBits } = require('discord.js');
const { isValidSound } = require('./sounds');

const YOUTUBE_RE = /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/;
const TIKTOK_RE = /https?:\/\/(www\.)?tiktok\.com\/.+/;
const DIRECT_MEDIA_RE = /https?:\/\/.+\.(jpg|jpeg|png|gif|webp|mp4|webm)(\?.*)?$/i;
const VOICE_MESSAGE_FLAG = 8192;

function parseMessage(message) {
  if (message.author.bot) return null;

  let media = null;
  let audio = null;
  let target = null;

  // Extraire target depuis les mentions
  const mentionedUsers = [...message.mentions.users.values()];
  if (mentionedUsers.length > 0) {
    target = mentionedUsers[0].username;
  }

  const content = message.content.trim();

  // Commande /sound
  if (content.startsWith('/sound')) {
    const parts = content.split(' ');
    const soundName = parts[1];
    if (soundName && isValidSound(soundName)) {
      audio = { type: 'sfx', url: `sfx:${soundName.toLowerCase()}` };
      return { media, audio, effects: [], target };
    }
    return null;
  }

  // Commande /react
  if (content.startsWith('/react')) {
    const emoji = content.replace('/react', '').trim();
    if (emoji) {
      media = { type: 'emoji', url: emoji };
      return { media, audio, effects: [], target };
    }
    return null;
  }

  // Attachements (images, vidéos, voix)
  const attachments = [...message.attachments.values()];
  for (const att of attachments) {
    const isVoice = (att.flags & VOICE_MESSAGE_FLAG) !== 0;
    const ct = att.contentType || '';

    if (isVoice || ct.startsWith('audio/')) {
      audio = { type: 'voice', url: att.url };
      continue;
    }
    if (ct.startsWith('image/')) {
      const type = ct === 'image/gif' ? 'gif' : 'image';
      media = { type, url: att.url };
      continue;
    }
    if (ct.startsWith('video/')) {
      media = { type: 'video', url: att.url };
      continue;
    }
  }

  if (media || audio) return { media, audio, effects: [], target };

  // URLs dans le contenu
  if (YOUTUBE_RE.test(content)) {
    const url = content.match(YOUTUBE_RE)[0];
    return { media: { type: 'youtube', url }, audio: null, effects: [], target };
  }
  if (TIKTOK_RE.test(content)) {
    const url = content.match(TIKTOK_RE)[0];
    return { media: { type: 'tiktok', url }, audio: null, effects: [], target };
  }
  if (DIRECT_MEDIA_RE.test(content)) {
    const url = content.match(DIRECT_MEDIA_RE)[0];
    const ext = url.split('.').pop().split('?')[0].toLowerCase();
    const type = ext === 'gif' ? 'gif' : ['mp4', 'webm'].includes(ext) ? 'video' : 'image';
    return { media: { type, url }, audio: null, effects: [], target };
  }

  return null;
}

function startBot(router) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    console.log(`[bot] connecté en tant que ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    if (message.channelId !== process.env.DISCORD_CHANNEL_ID) return;

    const event = parseMessage(message);
    if (!event) return;

    console.log(`[bot] drop reçu:`, JSON.stringify(event));
    router.dispatch(event);
  });

  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('[bot] Erreur de connexion:', err.message);
  });
}

module.exports = { startBot, parseMessage };
```

- [ ] **Step 5: Run tests — vérifier qu'ils passent**

```bash
cd server && npx jest tests/bot.test.js
```

Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add server/bot.js server/sounds.js server/tests/bot.test.js
git commit -m "feat(server): add discord bot with message parsing"
```

---

## Task 5: Server — Audio Proxy

**Files:**
- Create: `server/audioProxy.js`
- Create: `server/tests/audioProxy.test.js`

- [ ] **Step 1: Créer le dossier audio_cache**

```bash
mkdir -p server/audio_cache
echo "audio_cache/*.ogg" >> .gitignore
echo "audio_cache/*.mp3" >> .gitignore
```

- [ ] **Step 2: Écrire le test**

`server/tests/audioProxy.test.js`:
```js
const { resolveAudioUrl } = require('../audioProxy');

describe('resolveAudioUrl', () => {
  test('sfx: URL retournée telle quelle', async () => {
    const result = await resolveAudioUrl('sfx:airhorn', 'http://localhost:3000');
    expect(result).toBe('sfx:airhorn');
  });

  test('URL non-Discord retournée telle quelle', async () => {
    const result = await resolveAudioUrl('https://example.com/sound.mp3', 'http://localhost:3000');
    expect(result).toBe('https://example.com/sound.mp3');
  });
});
```

- [ ] **Step 3: Run test — vérifier qu'il échoue**

```bash
cd server && npx jest tests/audioProxy.test.js
```

Expected: FAIL — `Cannot find module '../audioProxy'`

- [ ] **Step 4: Implémenter audioProxy.js**

`server/audioProxy.js`:
```js
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const CACHE_DIR = path.join(__dirname, 'audio_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// URL Discord CDN → télécharger et servir via notre serveur
// URL externe non-Discord → passer telle quelle
// sfx:name → passer tel quel (géré côté Electron)
async function resolveAudioUrl(originalUrl, publicBaseUrl) {
  if (!originalUrl || originalUrl.startsWith('sfx:')) return originalUrl;

  const isDiscordCdn = originalUrl.includes('cdn.discordapp.com') || originalUrl.includes('media.discordapp.net');
  if (!isDiscordCdn) return originalUrl;

  try {
    const { default: fetch } = await import('node-fetch');
    const response = await fetch(originalUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const ext = originalUrl.includes('.ogg') ? 'ogg' : 'mp3';
    const filename = `${uuidv4()}.${ext}`;
    const filepath = path.join(CACHE_DIR, filename);

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(filepath, Buffer.from(arrayBuffer));

    // Cleanup après 5 minutes
    setTimeout(() => {
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }, 5 * 60 * 1000);

    return `${publicBaseUrl}/audio/${filename}`;
  } catch (err) {
    console.error('[audioProxy] erreur:', err.message);
    return originalUrl; // fallback: essayer l'URL originale
  }
}

module.exports = { resolveAudioUrl };
```

- [ ] **Step 5: Brancher audioProxy dans bot.js**

Dans `server/bot.js`, modifier `startBot` pour résoudre les URLs audio avant dispatch :

```js
// Ajouter en haut du fichier
const { resolveAudioUrl } = require('./audioProxy');

// Dans client.on('messageCreate'), remplacer :
//   router.dispatch(event);
// par :
    if (event.audio && event.audio.type === 'voice') {
      const publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
      event.audio.url = await resolveAudioUrl(event.audio.url, publicUrl);
    }
    router.dispatch(event);
```

- [ ] **Step 6: Run tous les tests server**

```bash
cd server && npx jest
```

Expected: PASS (tous les tests)

- [ ] **Step 7: Commit**

```bash
git add server/audioProxy.js server/tests/audioProxy.test.js server/bot.js
git commit -m "feat(server): add audio proxy for discord CDN files"
```

---

## Task 6: Overlay — Electron Main Process

**Files:**
- Create: `overlay/main.js`
- Create: `overlay/preload.js`

- [ ] **Step 1: Créer overlay/preload.js**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memedrop', {
  // Renderer → Main
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openSettings: () => ipcRenderer.send('open-settings'),

  // Main → Renderer
  onDrop: (callback) => ipcRenderer.on('drop', (_event, data) => callback(data)),
  onSettingsChanged: (callback) => ipcRenderer.on('settings-changed', (_event, settings) => callback(settings)),
});
```

- [ ] **Step 2: Créer overlay/main.js**

```js
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { io } = require('socket.io-client');

const store = new Store({
  defaults: {
    serverUrl: 'http://localhost:3000',
    discordUsername: '',
    positionX: 50,
    positionY: 50,
    duration: 5000,
    volumeSfx: 80,
    volumeVoice: 100,
    effects: true,
  },
});

let overlayWindow = null;
let settingsWindow = null;
let tray = null;
let socketClient = null;

function createOverlayWindow() {
  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;

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
    },
  });

  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 600,
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

function connectSocket() {
  const settings = store.store;
  if (!settings.serverUrl || !settings.discordUsername) return;

  if (socketClient) socketClient.disconnect();

  socketClient = io(settings.serverUrl, { reconnectionAttempts: Infinity });

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
}

// IPC handlers
ipcMain.handle('get-settings', () => store.store);

ipcMain.handle('save-settings', (_event, newSettings) => {
  store.set(newSettings);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('settings-changed', store.store);
  }
  connectSocket();
  return store.store;
});

ipcMain.on('open-settings', createSettingsWindow);

app.whenReady().then(() => {
  createOverlayWindow();
  connectSocket();

  // Tray icon (icône système)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAMklEQVQ4jWNgGAWkAv8JMIwaMGrAqAGjBgweAwgZQHIAIe9TMoSQAUMuhIMGUNsAABgiBAABBzreAAAAAElFTkSuQmCC'
  );
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Settings', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]);
  tray.setToolTip('MemeDrop');
  tray.setContextMenu(contextMenu);
  tray.on('click', createSettingsWindow);
});

app.on('window-all-closed', (e) => e.preventDefault()); // garder en tray
```

- [ ] **Step 3: Test manuel — lancer l'overlay**

```bash
cd overlay && npx electron .
```

Expected: fenêtre transparente créée, icône tray visible, pas d'erreur console

- [ ] **Step 4: Commit**

```bash
git add overlay/main.js overlay/preload.js
git commit -m "feat(overlay): add electron main process with transparent overlay window and tray"
```

---

## Task 7: Overlay — HTML + Queue + Effets + Audio

**Files:**
- Create: `overlay/overlay.html`
- Create: `overlay/overlay.js`

- [ ] **Step 1: Créer overlay/overlay.html**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: transparent;
      overflow: hidden;
      width: 100vw;
      height: 100vh;
      position: relative;
      font-family: sans-serif;
    }

    #drop-container {
      position: absolute;
      max-width: 480px;
      max-height: 360px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      transition: none;
    }

    #drop-container img,
    #drop-container video {
      max-width: 480px;
      max-height: 320px;
      border-radius: 12px;
      object-fit: contain;
    }

    #drop-container iframe {
      width: 480px;
      height: 270px;
      border: none;
      border-radius: 12px;
    }

    .emoji-display {
      font-size: 120px;
      line-height: 1;
      filter: drop-shadow(0 4px 8px rgba(0,0,0,0.8));
    }

    #queue-badge {
      position: fixed;
      bottom: 16px;
      right: 16px;
      background: rgba(0,0,0,0.75);
      color: #fff;
      font-size: 13px;
      padding: 4px 10px;
      border-radius: 20px;
      display: none;
    }

    /* Effets */
    @keyframes shake {
      0%,100% { transform: translateX(0); }
      20% { transform: translateX(-8px) rotate(-2deg); }
      40% { transform: translateX(8px) rotate(2deg); }
      60% { transform: translateX(-6px) rotate(-1deg); }
      80% { transform: translateX(6px) rotate(1deg); }
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes bounce {
      0%,100% { transform: translateY(0); }
      30% { transform: translateY(-20px); }
      60% { transform: translateY(-8px); }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.8); }
      to { opacity: 1; transform: scale(1); }
    }
    .fx-shake { animation: shake 0.5s ease; }
    .fx-spin { animation: spin 0.8s linear; }
    .fx-bounce { animation: bounce 0.6s ease; }
    .fx-flip { transform: scaleX(-1); }
    .fx-fade { animation: fadeIn 0.3s ease; }
  </style>
</head>
<body>
  <div id="drop-container" style="display:none"></div>
  <div id="queue-badge"></div>
  <script src="overlay.js"></script>
</body>
</html>
```

- [ ] **Step 2: Créer overlay/overlay.js**

```js
const container = document.getElementById('drop-container');
const badge = document.getElementById('queue-badge');

let queue = [];
let isPlaying = false;
let settings = { positionX: 50, positionY: 50, duration: 5000, volumeSfx: 80, volumeVoice: 100 };

// Recevoir les settings initiaux et updates
window.memedrop.getSettings().then(s => { settings = s; applyPosition(); });
window.memedrop.onSettingsChanged(s => { settings = s; applyPosition(); });

// Recevoir les drops depuis main process
window.memedrop.onDrop(event => {
  queue.push(event);
  updateBadge();
  if (!isPlaying) processQueue();
});

function applyPosition() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.round((settings.positionX / 100) * vw - container.offsetWidth / 2);
  const y = Math.round((settings.positionY / 100) * vh - container.offsetHeight / 2);
  container.style.left = `${Math.max(0, x)}px`;
  container.style.top = `${Math.max(0, y)}px`;
}

function updateBadge() {
  if (queue.length > 0) {
    badge.style.display = 'block';
    badge.textContent = `+${queue.length} en attente`;
  } else {
    badge.style.display = 'none';
  }
}

async function processQueue() {
  if (queue.length === 0) { isPlaying = false; return; }
  isPlaying = true;

  const event = queue.shift();
  updateBadge();

  container.innerHTML = '';
  container.style.display = 'flex';

  // Afficher le media
  if (event.media) {
    const el = buildMediaElement(event.media);
    if (el) {
      container.appendChild(el);
      applyEffects(el, event.effects || []);
    }
  }

  // Jouer l'audio
  if (event.audio) {
    playAudio(event.audio);
  }

  applyPosition();

  const duration = settings.duration || 5000;
  await sleep(duration);

  container.style.display = 'none';
  container.innerHTML = '';

  await sleep(300); // petit délai entre les drops
  processQueue();
}

function buildMediaElement(media) {
  switch (media.type) {
    case 'image':
    case 'gif': {
      const img = document.createElement('img');
      img.src = media.url;
      return img;
    }
    case 'video': {
      const video = document.createElement('video');
      video.src = media.url;
      video.autoplay = true;
      video.loop = false;
      video.muted = true; // l'audio est joué séparément si nécessaire
      return video;
    }
    case 'youtube': {
      const iframe = document.createElement('iframe');
      const videoId = extractYoutubeId(media.url);
      iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1`;
      iframe.allow = 'autoplay';
      return iframe;
    }
    case 'emoji': {
      const div = document.createElement('div');
      div.className = 'emoji-display';
      div.textContent = media.url;
      return div;
    }
    default:
      return null;
  }
}

function applyEffects(el, effects) {
  effects.forEach(fx => {
    el.classList.add(`fx-${fx}`);
  });
}

function playAudio(audio) {
  if (audio.type === 'sfx') {
    const name = audio.url.replace('sfx:', '');
    const sfxPath = `sounds/${name}.mp3`;
    const a = new Audio(sfxPath);
    a.volume = (settings.volumeSfx || 80) / 100;
    a.play().catch(e => console.warn('[audio] sfx error:', e.message));
    return;
  }

  if (audio.type === 'voice' && audio.url) {
    const a = new Audio(audio.url);
    a.volume = (settings.volumeVoice || 100) / 100;
    a.play().catch(e => console.warn('[audio] voice error:', e.message));
  }
}

function extractYoutubeId(url) {
  const match = url.match(/(?:v=|youtu\.be\/)([^&?/]+)/);
  return match ? match[1] : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 3: Test manuel — simuler un drop**

Ouvrir les DevTools de l'overlay (`overlayWindow.webContents.openDevTools({ mode: 'detach' })` dans main.js temporairement), puis dans la console :

```js
window.memedrop.onDrop // vérifier que la fonction existe
```

Tester en envoyant manuellement un event depuis main.js via `overlayWindow.webContents.send('drop', { media: { type: 'emoji', url: '💀' }, audio: null, effects: ['shake'], target: null })`

Expected: emoji 💀 apparaît sur l'écran pendant 5s avec effet shake

- [ ] **Step 4: Commit**

```bash
git add overlay/overlay.html overlay/overlay.js
git commit -m "feat(overlay): add media display, queue, effects and audio playback"
```

---

## Task 8: Overlay — Settings UI

**Files:**
- Create: `overlay/settings.html`
- Create: `overlay/settings.js`

- [ ] **Step 1: Créer overlay/settings.html**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>MemeDrop Settings</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 24px; margin: 0; }
    h1 { font-size: 20px; margin-bottom: 24px; color: #7c3aed; }
    .field { margin-bottom: 20px; }
    label { display: block; font-size: 13px; color: #a0a0b0; margin-bottom: 6px; }
    input[type="text"], input[type="url"] {
      width: 100%; padding: 8px 12px; background: #2d2d44; border: 1px solid #444;
      border-radius: 6px; color: #fff; font-size: 14px;
    }
    input[type="range"] { width: 100%; accent-color: #7c3aed; }
    .range-row { display: flex; align-items: center; gap: 12px; }
    .range-value { min-width: 36px; text-align: right; font-size: 13px; color: #7c3aed; }
    .position-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
    }
    button {
      width: 100%; padding: 12px; background: #7c3aed; color: #fff; border: none;
      border-radius: 8px; font-size: 15px; cursor: pointer; margin-top: 8px;
    }
    button:hover { background: #6d28d9; }
    .status { font-size: 12px; color: #22c55e; margin-top: 8px; min-height: 16px; }
    .separator { border: none; border-top: 1px solid #333; margin: 20px 0; }
  </style>
</head>
<body>
  <h1>⚡ MemeDrop Settings</h1>

  <div class="field">
    <label>URL du serveur</label>
    <input type="url" id="serverUrl" placeholder="https://your-app.railway.app">
  </div>

  <div class="field">
    <label>Pseudo Discord (pour être ciblable)</label>
    <input type="text" id="discordUsername" placeholder="Tanguy">
  </div>

  <hr class="separator">

  <div class="field">
    <label>Position overlay — Horizontal (%)</label>
    <div class="range-row">
      <input type="range" id="positionX" min="0" max="100" step="1">
      <span class="range-value" id="positionXVal">50</span>
    </div>
  </div>

  <div class="field">
    <label>Position overlay — Vertical (%)</label>
    <div class="range-row">
      <input type="range" id="positionY" min="0" max="100" step="1">
      <span class="range-value" id="positionYVal">50</span>
    </div>
  </div>

  <div class="field">
    <label>Durée d'affichage (secondes)</label>
    <div class="range-row">
      <input type="range" id="duration" min="1" max="10" step="1">
      <span class="range-value" id="durationVal">5</span>s
    </div>
  </div>

  <hr class="separator">

  <div class="field">
    <label>Volume SFX (%)</label>
    <div class="range-row">
      <input type="range" id="volumeSfx" min="0" max="100" step="5">
      <span class="range-value" id="volumeSfxVal">80</span>
    </div>
  </div>

  <div class="field">
    <label>Volume voix (%)</label>
    <div class="range-row">
      <input type="range" id="volumeVoice" min="0" max="100" step="5">
      <span class="range-value" id="volumeVoiceVal">100</span>
    </div>
  </div>

  <button id="saveBtn">💾 Sauvegarder</button>
  <div class="status" id="status"></div>

  <script src="settings.js"></script>
</body>
</html>
```

- [ ] **Step 2: Créer overlay/settings.js**

```js
const fields = ['serverUrl', 'discordUsername', 'positionX', 'positionY', 'duration', 'volumeSfx', 'volumeVoice'];
const rangeFields = ['positionX', 'positionY', 'duration', 'volumeSfx', 'volumeVoice'];

// Charger les settings
window.memedrop.getSettings().then(settings => {
  fields.forEach(key => {
    const el = document.getElementById(key);
    if (el) el.value = settings[key] ?? el.value;
  });
  updateRangeDisplays();
});

// Live update des labels de range
rangeFields.forEach(key => {
  const input = document.getElementById(key);
  const display = document.getElementById(`${key}Val`);
  if (input && display) {
    input.addEventListener('input', () => { display.textContent = input.value; });
  }
});

function updateRangeDisplays() {
  rangeFields.forEach(key => {
    const input = document.getElementById(key);
    const display = document.getElementById(`${key}Val`);
    if (input && display) display.textContent = input.value;
  });
}

// Sauvegarder
document.getElementById('saveBtn').addEventListener('click', async () => {
  const newSettings = {};
  fields.forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    const val = el.type === 'range' ? Number(el.value) : el.value;
    newSettings[key] = key === 'duration' ? val * 1000 : val;
  });

  await window.memedrop.saveSettings(newSettings);

  const status = document.getElementById('status');
  status.textContent = '✅ Sauvegardé !';
  setTimeout(() => { status.textContent = ''; }, 2000);
});
```

- [ ] **Step 3: Test manuel — ouvrir les settings**

Lancer l'app, clic droit sur l'icône tray → Settings. Vérifier que les champs se chargent et que la sauvegarde fonctionne.

- [ ] **Step 4: Commit**

```bash
git add overlay/settings.html overlay/settings.js
git commit -m "feat(overlay): add settings window with position, volume, and duration config"
```

---

## Task 9: SFX — Ajouter les fichiers audio

**Files:**
- Create: `overlay/sounds/*.mp3`

- [ ] **Step 1: Télécharger des SFX libres de droits**

Option rapide — télécharger via curl depuis Pixabay (gratuit, libre de droits) :

```bash
cd overlay/sounds

# Airhorn
curl -L "https://cdn.pixabay.com/audio/2022/07/26/audio_124baa3f4e.mp3" -o airhorn.mp3
# Bruh
curl -L "https://cdn.pixabay.com/audio/2022/03/10/audio_c8c8a73467.mp3" -o bruh.mp3
# Vine boom
curl -L "https://cdn.pixabay.com/audio/2021/08/09/audio_a6b3d91dff.mp3" -o vine_boom.mp3
# Sad trombone (sad_violin placeholder)
curl -L "https://cdn.pixabay.com/audio/2022/03/15/audio_8a0e06c4f2.mp3" -o sad_violin.mp3
# Success / GG
curl -L "https://cdn.pixabay.com/audio/2021/08/04/audio_0625c1539c.mp3" -o gg.mp3
```

> **Note :** Si les URLs Pixabay ont changé, remplace-les avec n'importe quel `.mp3` de moins de 300KB depuis https://pixabay.com/sound-effects/ — les URLs exactes ne comptent pas, juste que les fichiers existent sous ces noms.

- [ ] **Step 2: Vérifier que les sons jouent**

Dans la console DevTools de l'overlay :
```js
const a = new Audio('sounds/airhorn.mp3');
a.volume = 0.8;
a.play();
```

Expected: son airhorn joue

- [ ] **Step 3: Commit**

```bash
git add overlay/sounds/
git commit -m "feat(overlay): add bundled SFX library"
```

---

## Task 10: Deploy Railway

**Files:**
- Create: `server/Procfile` (ou `railway.json`)
- Create: `README.md`

- [ ] **Step 1: Créer server/Procfile**

```
web: node index.js
```

- [ ] **Step 2: S'assurer que le port vient de process.env.PORT**

Dans `server/index.js`, vérifier que la ligne listen utilise bien `process.env.PORT || 3000`. (déjà fait en Task 3 — juste vérifier)

- [ ] **Step 3: Déployer sur Railway**

```bash
# Installer Railway CLI si pas déjà fait
npm install -g @railway/cli

# Login
railway login

# Créer le projet depuis le dossier server/
cd server
railway init
railway up
```

- [ ] **Step 4: Configurer les variables d'environnement sur Railway**

Dans le dashboard Railway (https://railway.app) :
- `DISCORD_TOKEN` = ton token Discord bot
- `DISCORD_CHANNEL_ID` = l'ID du channel #meme-drop
- `PUBLIC_URL` = l'URL Railway assignée (ex: `https://memedrop-production.up.railway.app`)
- `PORT` = Railway le set automatiquement

- [ ] **Step 5: Mettre à jour l'URL dans les settings Electron**

Lancer l'overlay → Settings → mettre l'URL Railway dans "URL du serveur"

- [ ] **Step 6: Créer README.md**

```markdown
# MemeDrop Clone

Overlay Discord pour afficher des mèmes en temps réel sur les écrans de tes potes.

## Setup

### 1. Créer le bot Discord
- Aller sur https://discord.com/developers/applications
- Créer une application → Bot
- Activer `Message Content Intent`
- Copier le token

### 2. Déployer le serveur (Railway)
\`\`\`bash
cd server
railway login && railway init && railway up
\`\`\`
Variables requises : `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `PUBLIC_URL`

### 3. Lancer l'overlay
\`\`\`bash
cd overlay && npm start
\`\`\`
Configurer l'URL Railway et ton pseudo Discord dans les Settings (clic droit tray).

## Commandes Discord (dans #meme-drop)
- Poster une image/GIF → drop sur tout le monde
- Poster image + fichier audio → drop avec son
- Envoyer un voice message → audio seul
- `/sound airhorn` → SFX
- `/sound airhorn @Pseudo` → SFX ciblé
- `/react 💀` → emoji géant
```

- [ ] **Step 7: Commit final**

```bash
git add server/Procfile README.md
git commit -m "chore: add railway deploy config and README"
```

---

## Récap des commandes utiles

```bash
# Lancer le serveur en local
cd server && node index.js

# Lancer l'overlay
cd overlay && npx electron .

# Lancer tous les tests
cd server && npx jest

# Builder l'exe Windows
cd overlay && npx electron-builder --win --x64
```

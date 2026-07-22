require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createRouter } = require('./router');
const { resolveMedia } = require('./resolveMedia');
const { checkSendAuth } = require('./sendAuth');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const persistentRoot = process.env.PERSISTENT_DATA_DIR || '/data';
const tempAudioDir = path.join(__dirname, 'audio_cache');
const persistentAudioDir = path.join(persistentRoot, 'audio_cache');
const chaseLibraryFile = path.join(persistentRoot, 'chase-audio-library.json');
const chaseSessionsFile = path.join(persistentRoot, 'chase-sessions.json');
const chaseLeaderboardFile = path.join(persistentRoot, 'chase-leaderboard.json');
const authUsersFile = path.join(persistentRoot, 'auth-users.json');
const authSecretFile = path.join(persistentRoot, 'auth-secret.txt');
const CHASE_MIN_SCORE_MS = 30 * 1000;

// Servir les fichiers audio et media proxiés
app.use('/audio', express.static(tempAudioDir));
app.use('/audio', express.static(persistentAudioDir));
app.use('/media', express.static(path.join(__dirname, 'media_cache')));

// Page mobile "Quick Drop" (envoyer depuis le téléphone)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/send', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'send', 'index.html')));

// Purge cache files older than 1 hour on startup (survives server crashes)
function purgeStaleCache(dir) {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 60 * 60 * 1000;
  fs.readdirSync(dir).forEach(f => {
    try {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    } catch {}
  });
}
purgeStaleCache(tempAudioDir);
purgeStaleCache(path.join(__dirname, 'media_cache'));

const router = createRouter(io);

function publicUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function audioExt(original, mime) {
  const originalExt = path.extname(path.basename(original || '')).toLowerCase().replace('.', '');
  return ['aac', 'm4a', 'mp3', 'ogg', 'wav', 'webm'].includes(originalExt)
    ? originalExt
    : mime.includes('webm') ? 'webm'
    : mime.includes('ogg') ? 'ogg'
    : mime.includes('wav') ? 'wav'
    : mime.includes('mp4') ? 'm4a'
    : 'mp3';
}

function cleanAudioName(name, fallback = 'Audio') {
  return path.basename(name || fallback, path.extname(name || '')).replace(/[^\w .()[\]-]+/g, '').trim().slice(0, 80) || fallback;
}

function cleanPlaylistName(name) {
  return String(name || 'Playlist').replace(/[^\w .()[\]-]+/g, '').trim().slice(0, 40) || 'Playlist';
}

function loadChaseLibrary() {
  try {
    const parsed = JSON.parse(fs.readFileSync(chaseLibraryFile, 'utf8'));
    return {
      music: Array.isArray(parsed.music) ? parsed.music : [],
      playlists: Array.isArray(parsed.playlists) ? parsed.playlists.map(playlist => ({
        id: String(playlist.id || ''),
        name: cleanPlaylistName(playlist.name),
        trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds.map(String) : [],
      })).filter(playlist => playlist.id && playlist.name) : [],
      sfx: {
        start: parsed.sfx?.start || null,
        end: parsed.sfx?.end || null,
        checkpoints: Array.isArray(parsed.sfx?.checkpoints) ? parsed.sfx.checkpoints : [],
      },
    };
  } catch {
    return { music: [], playlists: [], sfx: { start: null, end: null, checkpoints: [] } };
  }
}

function saveChaseLibrary(library) {
  fs.mkdirSync(persistentRoot, { recursive: true });
  fs.writeFileSync(chaseLibraryFile, JSON.stringify(library, null, 2));
}

function cleanSessionCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function cleanPlayerName(name) {
  return String(name || 'Player').replace(/[^\w .()[\]-]+/g, '').trim().slice(0, 32) || 'Player';
}

function loadAuthSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try {
    const existing = fs.readFileSync(authSecretFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  fs.mkdirSync(persistentRoot, { recursive: true });
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(authSecretFile, secret);
  return secret;
}

function loadAuthUsers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(authUsersFile, 'utf8'));
    return { users: Array.isArray(parsed.users) ? parsed.users : [] };
  } catch {
    return { users: [] };
  }
}

function saveAuthUsers(data) {
  fs.mkdirSync(persistentRoot, { recursive: true });
  fs.writeFileSync(authUsersFile, JSON.stringify(data, null, 2));
}

function cleanUsername(name) {
  return String(name || '').replace(/[^\w .()[\]-]+/g, '').trim().slice(0, 32);
}

function adminUsers() {
  return new Set(String(process.env.ADMIN_USERS || 'VoidHoe').split(',').map(name => name.trim().toLowerCase()).filter(Boolean));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('base64url');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt] = String(stored || '').split(':');
  if (!salt) return false;
  const expected = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(stored)));
}

function signAuthToken(user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.username, role: user.role || 'user', iat: Date.now() })).toString('base64url');
  const signature = crypto.createHmac('sha256', loadAuthSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', loadAuthSecret()).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const user = loadAuthUsers().users.find(item => item.username.toLowerCase() === String(parsed.sub || '').toLowerCase());
  if (!user) return null;
  return { username: user.username, role: user.role || 'user' };
}

function authUser(req) {
  const header = req.get('Authorization') || '';
  return verifyAuthToken(header.replace(/^Bearer\s+/i, ''));
}

function publicAuthUser(user) {
  return user ? { username: user.username, role: user.role || 'user' } : null;
}

function cleanSessionName(name, fallback = 'Chase Session') {
  return String(name || fallback).replace(/[^\w .()[\]-]+/g, '').trim().slice(0, 40) || fallback;
}

function loadChaseSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(chaseSessionsFile, 'utf8'));
    return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
  } catch {
    return { sessions: [] };
  }
}

function saveChaseSessions(data) {
  fs.mkdirSync(persistentRoot, { recursive: true });
  fs.writeFileSync(chaseSessionsFile, JSON.stringify(data, null, 2));
}

function loadChaseLeaderboard() {
  try {
    const parsed = JSON.parse(fs.readFileSync(chaseLeaderboardFile, 'utf8'));
    return {
      players: Array.isArray(parsed.players) ? parsed.players : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return { players: [], runs: [] };
  }
}

function saveChaseLeaderboard(data) {
  fs.mkdirSync(persistentRoot, { recursive: true });
  fs.writeFileSync(chaseLeaderboardFile, JSON.stringify(data, null, 2));
}

function publicChaseLeaderboard(data) {
  return {
    players: (data.players || [])
      .map(player => ({
        name: player.name,
        bestMs: Number(player.bestMs) || 0,
        runs: Number(player.runs) || 0,
        updatedAt: player.updatedAt || null,
      }))
      .sort((a, b) => b.bestMs - a.bestMs || a.name.localeCompare(b.name)),
    recentRuns: (data.runs || [])
      .filter(run => !run.invalidated)
      .slice(-12)
      .reverse()
      .map(run => ({
        id: run.id,
        player: run.player,
        durationMs: Number(run.durationMs) || 0,
        counted: !!run.counted,
        at: run.at,
      })),
  };
}

function rebuildLeaderboardPlayers(data) {
  const byPlayer = new Map();
  (data.runs || []).forEach((run) => {
    const name = cleanPlayerName(run.player);
    if (!byPlayer.has(name)) byPlayer.set(name, { name, bestMs: 0, runs: 0, updatedAt: null });
    const record = byPlayer.get(name);
    record.runs += 1;
    if (!run.invalidated && run.counted && Number(run.durationMs) > record.bestMs) {
      record.bestMs = Number(run.durationMs) || 0;
      record.updatedAt = run.at || Date.now();
    }
  });
  data.players = [...byPlayer.values()];
  return data;
}

function publicSession(session) {
  const players = Array.isArray(session.players) ? session.players : [];
  return {
    code: session.code,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    playerCount: players.length,
    players: players
      .map(player => ({
        name: player.name,
        bestMs: Number(player.bestMs) || 0,
        runs: Number(player.runs) || 0,
        updatedAt: player.updatedAt || null,
      }))
      .sort((a, b) => b.bestMs - a.bestMs || a.name.localeCompare(b.name)),
  };
}

function makeSessionCode(existing) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!existing.has(code)) return code;
  }
  return `${Date.now()}`.slice(-6);
}

function savePersistentAudio(req, prefix) {
  const original = req.get('X-File-Name') || '';
  const ext = audioExt(original, req.get('Content-Type') || '');
  fs.mkdirSync(persistentAudioDir, { recursive: true });
  const filename = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
  const filepath = path.join(persistentAudioDir, filename);
  fs.writeFileSync(filepath, req.body);
  return {
    id: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: cleanAudioName(original, prefix === 'music' ? 'Music' : 'SFX'),
    url: `${publicUrl(req)}/audio/${filename}`,
    filename,
    uploadedAt: Date.now(),
  };
}

function removePersistentAudioFile(entry) {
  const filename = path.basename(entry?.filename || '');
  if (!filename) return;
  const filepath = path.join(persistentAudioDir, filename);
  const resolved = path.resolve(filepath);
  const root = path.resolve(persistentAudioDir);
  if (!resolved.startsWith(`${root}${path.sep}`)) return;
  try {
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  } catch (err) {
    console.warn('[api] could not delete chase audio file:', err.message);
  }
}

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

io.on('connection', (socket) => {
  function relayFacecam(eventName, payload) {
    const event = { ...(payload || {}), from: socket.discordUsername || null };
    io.sockets.sockets.forEach(client => {
      if (client.id === socket.id || !client.discordUsername) return;
      if (event.target && client.discordUsername !== event.target) return;
      client.emit(eventName, event);
    });
  }

  socket.on('facecam-start', payload => relayFacecam('facecam-start', payload));
  socket.on('facecam-frame', payload => {
    if (!payload?.image || String(payload.image).length > 260000) return;
    relayFacecam('facecam-frame', payload);
  });
  socket.on('facecam-stop', payload => relayFacecam('facecam-stop', payload));
});

// Exposer le router au bot
app.locals.router = router;

// Liste des utilisateurs connectés (pseudo Discord enregistrés)
app.get('/api/users', (_req, res) => {
  const users = [];
  io.sockets.sockets.forEach(socket => {
    if (socket.discordUsername) users.push(socket.discordUsername);
  });
  res.json({ users });
});

// Upload media direct depuis l'overlay app (images, GIFs, vidéos)
app.get('/api/chase-audio', (_req, res) => {
  res.json(loadChaseLibrary());
});

app.post('/api/chase-audio/music', express.raw({ type: 'audio/*', limit: '50mb' }), (req, res) => {
  try {
    const library = loadChaseLibrary();
    const entry = savePersistentAudio(req, 'music');
    library.music.unshift(entry);
    saveChaseLibrary(library);
    res.json({ ok: true, entry, library });
  } catch (err) {
    console.error('[api] erreur chase music:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chase-audio/music/:id', (req, res) => {
  const library = loadChaseLibrary();
  const index = library.music.findIndex(entry => entry.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'music not found' });
  const [removed] = library.music.splice(index, 1);
  library.playlists = (library.playlists || []).map(playlist => ({
    ...playlist,
    trackIds: (playlist.trackIds || []).filter(trackId => trackId !== req.params.id),
  }));
  removePersistentAudioFile(removed);
  saveChaseLibrary(library);
  res.json({ ok: true, removed, library });
});

app.post('/api/chase-audio/playlists', (req, res) => {
  const library = loadChaseLibrary();
  const name = cleanPlaylistName(req.body?.name);
  const id = `playlist-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const playlist = { id, name, trackIds: [] };
  library.playlists = Array.isArray(library.playlists) ? library.playlists : [];
  library.playlists.push(playlist);
  saveChaseLibrary(library);
  res.json({ ok: true, playlist, library });
});

app.delete('/api/chase-audio/playlists/:id', (req, res) => {
  const library = loadChaseLibrary();
  const before = library.playlists.length;
  library.playlists = library.playlists.filter(playlist => playlist.id !== req.params.id);
  if (library.playlists.length === before) return res.status(404).json({ error: 'playlist not found' });
  saveChaseLibrary(library);
  res.json({ ok: true, library });
});

app.put('/api/chase-audio/music/:id/playlist', (req, res) => {
  const library = loadChaseLibrary();
  const track = library.music.find(entry => entry.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'music not found' });
  const playlistId = String(req.body?.playlistId || '');
  if (playlistId && !library.playlists.some(playlist => playlist.id === playlistId)) {
    return res.status(404).json({ error: 'playlist not found' });
  }
  library.playlists = library.playlists.map(playlist => ({
    ...playlist,
    trackIds: (playlist.trackIds || []).filter(trackId => trackId !== track.id),
  }));
  if (playlistId) {
    const playlist = library.playlists.find(item => item.id === playlistId);
    playlist.trackIds.push(track.id);
  }
  saveChaseLibrary(library);
  res.json({ ok: true, library });
});

app.post('/api/auth/register', (req, res) => {
  const username = cleanUsername(req.body?.username);
  const password = String(req.body?.password || '');
  if (!username || password.length < 4) return res.status(400).json({ error: 'username and 4+ char password required' });
  const data = loadAuthUsers();
  if (data.users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'username already exists' });
  }
  const user = {
    username,
    passwordHash: hashPassword(password),
    role: adminUsers().has(username.toLowerCase()) ? 'admin' : 'user',
    createdAt: Date.now(),
  };
  data.users.push(user);
  saveAuthUsers(data);
  const token = signAuthToken(user);
  res.json({ ok: true, token, user: publicAuthUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const username = cleanUsername(req.body?.username);
  const password = String(req.body?.password || '');
  const user = loadAuthUsers().users.find(item => item.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'invalid username or password' });
  }
  if (adminUsers().has(user.username.toLowerCase()) && user.role !== 'admin') {
    const data = loadAuthUsers();
    const stored = data.users.find(item => item.username.toLowerCase() === user.username.toLowerCase());
    if (stored) {
      stored.role = 'admin';
      saveAuthUsers(data);
      user.role = 'admin';
    }
  }
  const token = signAuthToken(user);
  res.json({ ok: true, token, user: publicAuthUser(user) });
});

app.get('/api/auth/me', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'not authenticated' });
  res.json({ ok: true, user: publicAuthUser(user) });
});

app.get('/api/chase-leaderboard', (_req, res) => {
  res.json({ leaderboard: publicChaseLeaderboard(loadChaseLeaderboard()) });
});

app.post('/api/chase-leaderboard/score', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });
  const durationMs = Math.max(0, Math.floor(Number(req.body?.durationMs) || 0));
  const player = cleanPlayerName(user.username);
  const data = loadChaseLeaderboard();
  data.players = Array.isArray(data.players) ? data.players : [];
  data.runs = Array.isArray(data.runs) ? data.runs : [];
  const counted = durationMs >= CHASE_MIN_SCORE_MS;
  const now = Date.now();
  const run = {
    id: `run-${now}-${Math.random().toString(16).slice(2)}`,
    player,
    durationMs,
    counted,
    invalidated: false,
    at: now,
  };
  data.runs.push(run);
  let record = data.players.find(item => item.name.toLowerCase() === player.toLowerCase());
  if (!record) {
    record = { name: player, bestMs: 0, runs: 0, updatedAt: now };
    data.players.push(record);
  }
  record.runs = (Number(record.runs) || 0) + 1;
  if (counted && durationMs > (Number(record.bestMs) || 0)) {
    record.bestMs = durationMs;
    record.updatedAt = now;
  }
  saveChaseLeaderboard(data);
  const leaderboard = publicChaseLeaderboard(data);
  io.emit('chase-leaderboard-updated', leaderboard);
  res.json({ ok: true, counted, run, leaderboard });
});

app.post('/api/chase-leaderboard/runs/:id/invalidate', (req, res) => {
  const user = authUser(req);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'admin required' });
  const data = loadChaseLeaderboard();
  const run = (data.runs || []).find(item => item.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  run.invalidated = true;
  run.invalidatedBy = user.username;
  run.invalidatedAt = Date.now();
  rebuildLeaderboardPlayers(data);
  saveChaseLeaderboard(data);
  const leaderboard = publicChaseLeaderboard(data);
  io.emit('chase-leaderboard-updated', leaderboard);
  res.json({ ok: true, leaderboard });
});

app.get('/api/chase-sessions', (_req, res) => {
  const data = loadChaseSessions();
  res.json({
    sessions: data.sessions
      .map(publicSession)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 20),
  });
});

app.post('/api/chase-sessions', (req, res) => {
  const data = loadChaseSessions();
  const code = makeSessionCode(new Set(data.sessions.map(session => session.code)));
  const now = Date.now();
  const player = cleanPlayerName(req.body?.player);
  const session = {
    code,
    name: cleanSessionName(req.body?.name, `${player}'s Chase`),
    createdAt: now,
    updatedAt: now,
    players: player ? [{ name: player, bestMs: 0, runs: 0, updatedAt: now }] : [],
  };
  data.sessions.unshift(session);
  saveChaseSessions(data);
  res.json({ ok: true, session: publicSession(session) });
});

app.post('/api/chase-sessions/:code/join', (req, res) => {
  const code = cleanSessionCode(req.params.code);
  const player = cleanPlayerName(req.body?.player);
  const data = loadChaseSessions();
  const session = data.sessions.find(item => item.code === code);
  if (!session) return res.status(404).json({ error: 'session not found' });
  session.players = Array.isArray(session.players) ? session.players : [];
  if (!session.players.some(item => item.name.toLowerCase() === player.toLowerCase())) {
    session.players.push({ name: player, bestMs: 0, runs: 0, updatedAt: Date.now() });
  }
  session.updatedAt = Date.now();
  saveChaseSessions(data);
  res.json({ ok: true, session: publicSession(session) });
});

app.get('/api/chase-sessions/:code', (req, res) => {
  const code = cleanSessionCode(req.params.code);
  const session = loadChaseSessions().sessions.find(item => item.code === code);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json({ session: publicSession(session) });
});

app.post('/api/chase-sessions/:code/score', (req, res) => {
  const code = cleanSessionCode(req.params.code);
  const durationMs = Math.floor(Number(req.body?.durationMs) || 0);
  const player = cleanPlayerName(req.body?.player);
  const data = loadChaseSessions();
  const session = data.sessions.find(item => item.code === code);
  if (!session) return res.status(404).json({ error: 'session not found' });
  session.players = Array.isArray(session.players) ? session.players : [];
  let record = session.players.find(item => item.name.toLowerCase() === player.toLowerCase());
  if (!record) {
    record = { name: player, bestMs: 0, runs: 0, updatedAt: Date.now() };
    session.players.push(record);
  }
  record.runs = (Number(record.runs) || 0) + 1;
  if (durationMs >= CHASE_MIN_SCORE_MS && durationMs > (Number(record.bestMs) || 0)) {
    record.bestMs = durationMs;
    record.updatedAt = Date.now();
  }
  session.updatedAt = Date.now();
  saveChaseSessions(data);
  io.emit('chase-session-updated', publicSession(session));
  res.json({ ok: true, counted: durationMs >= CHASE_MIN_SCORE_MS, session: publicSession(session) });
});

app.post('/api/chase-audio/sfx-reset', (_req, res) => {
  const library = loadChaseLibrary();
  library.sfx = { start: null, end: null, checkpoints: [] };
  saveChaseLibrary(library);
  res.json({ ok: true, library });
});

app.post('/api/chase-audio/sfx', express.raw({ type: 'audio/*', limit: '50mb' }), (req, res) => {
  try {
    const role = ['start', 'end', 'checkpoint'].includes(req.get('X-MemeDrop-Sfx-Role'))
      ? req.get('X-MemeDrop-Sfx-Role')
      : 'checkpoint';
    const library = loadChaseLibrary();
    const entry = savePersistentAudio(req, 'sfx');
    entry.role = role;
    if (role === 'start') library.sfx.start = entry;
    else if (role === 'end') library.sfx.end = entry;
    else library.sfx.checkpoints.push(entry);
    saveChaseLibrary(library);
    res.json({ ok: true, entry, library });
  } catch (err) {
    console.error('[api] erreur chase sfx:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-media', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  try {
    const ct = req.get('Content-Type') || '';
    let ext = 'jpg';
    if      (ct.includes('gif'))  ext = 'gif';
    else if (ct.includes('webm')) ext = 'webm';
    else if (ct.includes('mp4'))  ext = 'mp4';
    else if (ct.includes('png'))  ext = 'png';
    else if (ct.includes('webp')) ext = 'webp';
    else if (ct.includes('jpeg')) ext = 'jpg';

    const filename  = `media-${Date.now()}.${ext}`;
    const mediaDir  = path.join(__dirname, 'media_cache');
    fs.mkdirSync(mediaDir, { recursive: true });
    const filepath = path.join(mediaDir, filename);
    fs.writeFileSync(filepath, req.body);
    setTimeout(() => { try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch {} }, 5 * 60 * 1000);
    const publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
    console.log(`[api] media uploadé: ${filename}`);
    res.json({ url: `${publicUrl}/media/${filename}` });
  } catch (err) {
    console.error('[api] erreur upload media:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Vérifie le mot de passe de la page mobile /send (soft lock).
app.post('/api/send-auth', (req, res) => {
  const { password } = req.body || {};
  res.json(checkSendAuth(password, process.env.SEND_PASSWORD));
});

// API drop directe (depuis l'overlay app OU la page mobile, sans passer par Discord)
app.post('/api/drop', async (req, res) => {
  const { media, mediaUrl, audio, effects, target, caption, captionTop, captionBottom, captionStyle, fadeInDuration, fadeOutDuration, positionX, positionY,
          loop, loopDuration, loopTimes, trimStart, trimEnd, size, from, action } = req.body;

  // La page mobile envoie une URL brute (mediaUrl) ; on la résout côté serveur.
  // L'app desktop envoie déjà un objet `media` résolu → on n'y touche pas.
  let resolved = media || null;
  if (!resolved && mediaUrl) {
    try { resolved = await resolveMedia(mediaUrl); }
    catch (e) { console.error('[api] resolveMedia échec:', e.message); }
  }

  if (!resolved && !audio && !action) return res.status(400).json({ error: 'media, audio ou action requis' });

  router.dispatch({
    media:        resolved  || null,
    audio:        audio     || null,
    effects:      effects   || [],
    target:       target    || null,
    caption:      caption   || null,
    captionTop:   captionTop    || null,
    captionBottom: captionBottom || null,
    captionStyle: captionStyle === 'card' ? 'card' : 'overlay',
    fadeInDuration: fadeInDuration ?? null,
    fadeOutDuration: fadeOutDuration ?? null,
    positionX:    positionX ?? null,
    positionY:    positionY ?? null,
    loop:         loop      ?? false,
    loopDuration: loopDuration || null,
    loopTimes:    loopTimes || null,
    trimStart:    trimStart ?? null,
    trimEnd:      trimEnd ?? null,
    size:         size      || 'm',
    from:         from      || null,
    action:       action    || null,
  });

  console.log(`[api] drop reçu:`, JSON.stringify(req.body));
  res.json({ ok: true });
});

// Upload audio direct depuis l'overlay app
app.post('/api/upload-audio', express.raw({ type: 'audio/*', limit: '50mb' }), (req, res) => {
  try {
    const original = path.basename(req.get('X-File-Name') || '');
    const originalExt = path.extname(original).toLowerCase().replace('.', '');
    const mime = req.get('Content-Type') || '';
    const ext = ['aac', 'm4a', 'mp3', 'ogg', 'wav', 'webm'].includes(originalExt)
      ? originalExt
      : mime.includes('webm') ? 'webm'
      : mime.includes('ogg') ? 'ogg'
      : mime.includes('wav') ? 'wav'
      : mime.includes('mp4') ? 'm4a'
      : 'mp3';
    const persistent = req.get('X-MemeDrop-Persistent') === 'chase';
    const filename = `drop-${Date.now()}.${ext}`;
    const audioDir = persistent ? persistentAudioDir : tempAudioDir;
    fs.mkdirSync(audioDir, { recursive: true });
    const filepath = path.join(audioDir, filename);
    fs.writeFileSync(filepath, req.body);
    if (!persistent) {
      setTimeout(() => { try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch {} }, 5 * 60 * 1000);
    }
    const publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
    console.log(`[api] audio uploadé: ${filename}`);
    res.json({ url: `${publicUrl}/audio/${filename}` });
  } catch (err) {
    console.error('[api] erreur upload audio:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] écoute sur le port ${PORT}`);

  // Start bot if available
  try {
    const { startBot } = require('./bot');
    startBot(router);
  } catch (e) {
    console.warn('[server] bot not available:', e.message);
  }
});

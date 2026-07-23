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
const profileAvatarDir = path.join(persistentRoot, 'profile_avatars');
const chaseLibraryFile = path.join(persistentRoot, 'chase-audio-library.json');
const chaseLeaderboardFile = path.join(persistentRoot, 'chase-leaderboard.json');
const lolLeaderboardFile = path.join(persistentRoot, 'lol-leaderboard.json');
const authUsersFile = path.join(persistentRoot, 'auth-users.json');
const authSecretFile = path.join(persistentRoot, 'auth-secret.txt');
const CHASE_MIN_SCORE_MS = 30 * 1000;
const RIOT_REFRESH_MS = 15 * 60 * 1000;
const RIOT_PLATFORM_REGIONS = new Set(['br1', 'eun1', 'euw1', 'jp1', 'kr', 'la1', 'la2', 'me1', 'na1', 'oc1', 'ru', 'sg2', 'tr1', 'tw2', 'vn2']);
const RIOT_ACCOUNT_REGIONS = {
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  na1: 'americas',
  oc1: 'americas',
  kr: 'asia',
  jp1: 'asia',
  eun1: 'europe',
  euw1: 'europe',
  me1: 'europe',
  ru: 'europe',
  tr1: 'europe',
  sg2: 'asia',
  tw2: 'asia',
  vn2: 'asia',
};
const RIOT_TIER_SCORE = {
  IRON: 0,
  BRONZE: 400,
  SILVER: 800,
  GOLD: 1200,
  PLATINUM: 1600,
  EMERALD: 2000,
  DIAMOND: 2400,
  MASTER: 2800,
  GRANDMASTER: 3000,
  CHALLENGER: 3200,
};
const RIOT_DIVISION_SCORE = { IV: 0, III: 100, II: 200, I: 300 };

// Servir les fichiers audio et media proxiés
app.use('/audio', express.static(tempAudioDir));
app.use('/audio', express.static(persistentAudioDir));
app.use('/avatars', express.static(profileAvatarDir));
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

function imageExt(original, mime) {
  const originalExt = path.extname(path.basename(original || '')).toLowerCase().replace('.', '');
  return ['gif', 'jpg', 'jpeg', 'png', 'webp'].includes(originalExt)
    ? (originalExt === 'jpeg' ? 'jpg' : originalExt)
    : mime.includes('gif') ? 'gif'
    : mime.includes('png') ? 'png'
    : mime.includes('webp') ? 'webp'
    : 'jpg';
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

function findStoredUser(username) {
  const clean = cleanUsername(username).toLowerCase();
  if (!clean) return null;
  return loadAuthUsers().users.find(item => item.username.toLowerCase() === clean) || null;
}

function saveAuthUsers(data) {
  fs.mkdirSync(persistentRoot, { recursive: true });
  fs.writeFileSync(authUsersFile, JSON.stringify(data, null, 2));
}

function cleanUsername(name) {
  return String(name || '').replace(/[^\w .()[\]-]+/g, '').trim().slice(0, 32);
}

function cleanRiotPart(value, max = 32) {
  return String(value || '').replace(/[^\p{L}\p{N} _.-]+/gu, '').trim().slice(0, max);
}

function cleanRiotRegion(value) {
  const region = String(value || 'euw1').toLowerCase();
  return RIOT_PLATFORM_REGIONS.has(region) ? region : 'euw1';
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
  try {
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', loadAuthSecret()).update(payload).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const user = findStoredUser(parsed.sub);
    if (!user) return null;
    return publicAuthUser(user);
  } catch {
    return null;
  }
}

function authUser(req) {
  const header = req.get('Authorization') || '';
  return verifyAuthToken(header.replace(/^Bearer\s+/i, ''));
}

function publicAuthUser(user) {
  return user ? { username: user.username, role: user.role || 'user', avatarUrl: user.avatarUrl || null } : null;
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

function startOfWeekMs(now = Date.now()) {
  const date = new Date(now);
  const day = date.getUTCDay();
  const diff = (day + 6) % 7;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - diff);
  return date.getTime();
}

function weekLabel(weekStart) {
  const date = new Date(Number(weekStart) || Date.now());
  return date.toISOString().slice(0, 10);
}

function leaderboardFromRuns(runs, { since = 0 } = {}) {
  const byPlayer = new Map();
  (runs || []).forEach((run) => {
    if (run.invalidated || !run.counted || Number(run.durationMs) < CHASE_MIN_SCORE_MS) return;
    if (since && Number(run.at) < since) return;
    const name = cleanPlayerName(run.player);
    if (!byPlayer.has(name)) byPlayer.set(name, { name, bestMs: 0, runs: 0, updatedAt: null });
    const record = byPlayer.get(name);
    record.runs += 1;
    if (Number(run.durationMs) > record.bestMs) {
      record.bestMs = Number(run.durationMs) || 0;
      record.updatedAt = run.at || Date.now();
    }
  });
  return [...byPlayer.values()];
}

function avatarLookup() {
  const users = loadAuthUsers().users || [];
  return new Map(users.map(user => [cleanPlayerName(user.username).toLowerCase(), user.avatarUrl || null]));
}

function withPlayerAvatars(players) {
  const avatars = avatarLookup();
  return (players || []).map(player => ({
    ...player,
    avatarUrl: avatars.get(cleanPlayerName(player.name).toLowerCase()) || player.avatarUrl || null,
  }));
}

function weeklyPodiums(runs) {
  const byWeek = new Map();
  (runs || []).forEach((run) => {
    if (run.invalidated || !run.counted || Number(run.durationMs) < CHASE_MIN_SCORE_MS) return;
    const weekStart = startOfWeekMs(Number(run.at) || Date.now());
    if (!byWeek.has(weekStart)) byWeek.set(weekStart, []);
    byWeek.get(weekStart).push(run);
  });
  return [...byWeek.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([weekStart, weekRuns]) => ({
      weekStart,
      label: weekLabel(weekStart),
      players: withPlayerAvatars(leaderboardFromRuns(weekRuns))
        .sort((a, b) => b.bestMs - a.bestMs || a.name.localeCompare(b.name))
        .slice(0, 3)
        .map((player, index) => ({ ...player, rank: index + 1 })),
    }))
    .filter(week => week.players.length);
}

function profileFromLeaderboard(data, user) {
  const player = cleanPlayerName(user.username);
  const storedUser = findStoredUser(user.username) || user;
  const now = Date.now();
  const weekStart = startOfWeekMs(now);
  const countedRuns = (data.runs || []).filter(run =>
    !run.invalidated &&
    run.counted &&
    Number(run.durationMs) >= CHASE_MIN_SCORE_MS &&
    cleanPlayerName(run.player).toLowerCase() === player.toLowerCase()
  );
  const weeklyRuns = countedRuns.filter(run => Number(run.at) >= weekStart);
  const currentWeekBoard = leaderboardFromRuns(data.runs || [], { since: weekStart })
    .sort((a, b) => b.bestMs - a.bestMs || a.name.localeCompare(b.name));
  const currentRank = currentWeekBoard.findIndex(item => item.name.toLowerCase() === player.toLowerCase());
  const badges = weeklyPodiums(data.runs || [])
    .flatMap(week => week.players
      .filter(item => item.name.toLowerCase() === player.toLowerCase())
      .map(item => ({
        weekStart: week.weekStart,
        week: week.label,
        rank: item.rank,
        bestMs: item.bestMs,
        runs: item.runs,
      })));
  const lolBoard = loadLolLeaderboard();
  const lolScore = (lolBoard.scores || []).find(score =>
    Number(score.weekStart) === weekStart &&
    cleanPlayerName(score.player).toLowerCase() === player.toLowerCase()
  );
  return {
    user: publicAuthUser(storedUser),
    stats: {
      totalRuns: countedRuns.length,
      allTimeBestMs: countedRuns.reduce((best, run) => Math.max(best, Number(run.durationMs) || 0), 0),
      weeklyRuns: weeklyRuns.length,
      weeklyBestMs: weeklyRuns.reduce((best, run) => Math.max(best, Number(run.durationMs) || 0), 0),
      currentWeekRank: currentRank >= 0 ? currentRank + 1 : null,
    },
    league: {
      riot: publicRiotLink(storedUser),
      weeklyGain: lolScore ? Math.floor(Number(lolScore.gain) || 0) : null,
      baselineLp: lolScore ? finiteNumberOrNull(lolScore.baselineLp) : null,
      currentLp: lolScore ? finiteNumberOrNull(lolScore.currentLp) : null,
      rankLabel: lolScore?.rankLabel || storedUser?.riot?.rankLabel || null,
      updatedAt: lolScore?.updatedAt || storedUser?.riot?.lastSyncedAt || null,
    },
    badges,
  };
}

function publicChaseLeaderboard(data) {
  const weekStart = startOfWeekMs();
  const players = leaderboardFromRuns(data.runs || [], { since: weekStart });
  const avatars = avatarLookup();
  return {
    scope: 'weekly',
    weekStart,
    minScoreMs: CHASE_MIN_SCORE_MS,
    podiums: weeklyPodiums(data.runs || []).slice(0, 12),
    players: withPlayerAvatars(players)
      .map(player => ({
        name: player.name,
        avatarUrl: player.avatarUrl || null,
        bestMs: Number(player.bestMs) || 0,
        runs: Number(player.runs) || 0,
        updatedAt: player.updatedAt || null,
      }))
      .sort((a, b) => b.bestMs - a.bestMs || a.name.localeCompare(b.name)),
    recentRuns: (data.runs || [])
      .filter(run => !run.invalidated && run.counted && Number(run.durationMs) >= CHASE_MIN_SCORE_MS && Number(run.at) >= weekStart)
      .slice(-12)
      .reverse()
      .map(run => ({
        id: run.id,
        player: run.player,
        avatarUrl: avatars.get(cleanPlayerName(run.player).toLowerCase()) || null,
        durationMs: Number(run.durationMs) || 0,
        counted: !!run.counted,
        at: run.at,
      })),
  };
}

function loadLolLeaderboard() {
  try {
    const parsed = JSON.parse(fs.readFileSync(lolLeaderboardFile, 'utf8'));
    return { scores: Array.isArray(parsed.scores) ? parsed.scores : [] };
  } catch {
    return { scores: [] };
  }
}

function saveLolLeaderboard(data) {
  fs.mkdirSync(persistentRoot, { recursive: true });
  fs.writeFileSync(lolLeaderboardFile, JSON.stringify(data, null, 2));
}

function rankedLpValue(entry) {
  if (!entry) return null;
  const tier = String(entry.tier || '').toUpperCase();
  const rank = String(entry.rank || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(RIOT_TIER_SCORE, tier)) return null;
  const division = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier) ? 0 : RIOT_DIVISION_SCORE[rank] ?? 0;
  return RIOT_TIER_SCORE[tier] + division + Math.floor(Number(entry.leaguePoints) || 0);
}

function publicRiotLink(user) {
  const riot = user?.riot || null;
  if (!riot?.gameName || !riot?.tagLine) return null;
  return {
    gameName: riot.gameName,
    tagLine: riot.tagLine,
    region: riot.region || 'euw1',
    label: `${riot.gameName}#${riot.tagLine}`,
    queue: riot.queue || 'RANKED_SOLO_5x5',
    rankLabel: riot.rankLabel || null,
    lastSyncedAt: riot.lastSyncedAt || null,
  };
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicLolLeaderboard(data) {
  const weekStart = startOfWeekMs();
  const avatars = avatarLookup();
  const players = (data.scores || [])
    .filter(score => Number(score.weekStart) === weekStart)
    .map(score => ({
      name: cleanPlayerName(score.player),
      avatarUrl: avatars.get(cleanPlayerName(score.player).toLowerCase()) || null,
      gain: Math.floor(Number(score.gain) || 0),
      baselineLp: finiteNumberOrNull(score.baselineLp),
      currentLp: finiteNumberOrNull(score.currentLp),
      rankLabel: score.rankLabel || null,
      riotId: score.riotId || null,
      updatedAt: score.updatedAt || null,
    }))
    .sort((a, b) => b.gain - a.gain || a.name.localeCompare(b.name))
    .map((score, index) => ({ ...score, rank: index + 1 }));
  return { scope: 'weekly', weekStart, players };
}

async function riotFetchJson(url) {
  const apiKey = process.env.RIOT_API_KEY || '';
  if (!apiKey) throw new Error('RIOT_API_KEY is missing on the server');
  const res = await fetch(url, { headers: { 'X-Riot-Token': apiKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.status?.message || `Riot API ${res.status}`);
  return data;
}

async function fetchRiotRank({ gameName, tagLine, region }) {
  const platform = cleanRiotRegion(region);
  const accountRegion = RIOT_ACCOUNT_REGIONS[platform] || 'europe';
  const account = await riotFetchJson(`https://${accountRegion}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
  const entries = await riotFetchJson(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(account.puuid)}`);
  const solo = (entries || []).find(entry => entry.queueType === 'RANKED_SOLO_5x5') || null;
  const currentLp = rankedLpValue(solo);
  return {
    accountRegion,
    puuid: account.puuid,
    queue: 'RANKED_SOLO_5x5',
    currentLp,
    rankLabel: solo ? `${solo.tier} ${solo.rank} ${solo.leaguePoints} LP` : 'Unranked',
  };
}

async function syncLolScoreForUser(storedUser, { force = false } = {}) {
  if (!storedUser?.riot?.gameName || !storedUser?.riot?.tagLine) return null;
  if (!force && storedUser.riot.lastSyncedAt && Date.now() - Number(storedUser.riot.lastSyncedAt) < RIOT_REFRESH_MS) return null;
  const rank = await fetchRiotRank(storedUser.riot);
  storedUser.riot = { ...storedUser.riot, ...rank, lastSyncedAt: Date.now() };
  const currentLp = Number(rank.currentLp);
  if (!Number.isFinite(currentLp)) return { unranked: true, rank };
  const board = loadLolLeaderboard();
  const weekStart = startOfWeekMs();
  const player = cleanPlayerName(storedUser.username);
  board.scores = Array.isArray(board.scores) ? board.scores : [];
  let score = board.scores.find(item => Number(item.weekStart) === weekStart && cleanPlayerName(item.player).toLowerCase() === player.toLowerCase());
  if (!score) {
    score = {
      id: `lol-${weekStart}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      player,
      weekStart,
      baselineLp: currentLp,
      currentLp,
      gain: 0,
      riotId: `${storedUser.riot.gameName}#${storedUser.riot.tagLine}`,
      rankLabel: rank.rankLabel,
      updatedAt: Date.now(),
    };
    board.scores.push(score);
  } else {
    if (!Number.isFinite(Number(score.baselineLp))) score.baselineLp = currentLp;
    score.currentLp = currentLp;
    score.gain = currentLp - Number(score.baselineLp);
    score.riotId = `${storedUser.riot.gameName}#${storedUser.riot.tagLine}`;
    score.rankLabel = rank.rankLabel;
    score.updatedAt = Date.now();
  }
  saveLolLeaderboard(board);
  return { score, rank };
}

async function refreshLinkedRiotScores({ force = false } = {}) {
  const data = loadAuthUsers();
  let changed = false;
  for (const user of data.users || []) {
    if (!user.riot?.gameName || !user.riot?.tagLine) continue;
    try {
      const result = await syncLolScoreForUser(user, { force });
      if (result) changed = true;
    } catch (err) {
      user.riot.lastError = err.message;
      user.riot.lastErrorAt = Date.now();
      changed = true;
    }
  }
  if (changed) saveAuthUsers(data);
  return publicLolLeaderboard(loadLolLeaderboard());
}

function saveProfileAvatar(req, user) {
  const mime = req.get('Content-Type') || '';
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mime)) throw new Error('image must be PNG, JPG, WEBP or GIF');
  if (!Buffer.isBuffer(req.body) || req.body.length < 16) throw new Error('image file is empty');
  const ext = imageExt(req.get('X-File-Name') || '', mime);
  fs.mkdirSync(profileAvatarDir, { recursive: true });
  const filename = `${cleanUsername(user.username).replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
  fs.writeFileSync(path.join(profileAvatarDir, filename), req.body);
  return `${publicUrl(req)}/avatars/${filename}`;
}

function rebuildLeaderboardPlayers(data) {
  data.players = leaderboardFromRuns(data.runs || []);
  return data;
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
  library.playlists = Array.isArray(library.playlists) ? library.playlists : [];
  const playlistId = String(req.body?.playlistId || '');
  const playlist = library.playlists.find(item => item.id === playlistId);
  if (!playlist) return res.status(404).json({ error: 'playlist not found' });
  const enabled = req.body?.enabled !== false;
  const ids = new Set(Array.isArray(playlist.trackIds) ? playlist.trackIds.map(String) : []);
  if (enabled) ids.add(track.id);
  else ids.delete(track.id);
  playlist.trackIds = [...ids];
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

app.get('/api/profile', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });
  const data = loadChaseLeaderboard();
  res.json({ ok: true, profile: profileFromLeaderboard(data, user), leaderboard: publicChaseLeaderboard(data) });
});

app.get('/api/profile/:username', (req, res) => {
  const stored = findStoredUser(req.params.username);
  if (!stored) return res.status(404).json({ error: 'profile not found' });
  const data = loadChaseLeaderboard();
  res.json({ ok: true, profile: profileFromLeaderboard(data, publicAuthUser(stored)), leaderboard: publicChaseLeaderboard(data) });
});

app.post('/api/profile/avatar', express.raw({ type: 'image/*', limit: '5mb' }), (req, res) => {
  const current = authUser(req);
  if (!current) return res.status(401).json({ error: 'login required' });
  try {
    const data = loadAuthUsers();
    const stored = data.users.find(item => item.username.toLowerCase() === current.username.toLowerCase());
    if (!stored) return res.status(404).json({ error: 'profile not found' });
    stored.avatarUrl = saveProfileAvatar(req, stored);
    stored.updatedAt = Date.now();
    saveAuthUsers(data);
    const leaderboard = loadChaseLeaderboard();
    res.json({ ok: true, user: publicAuthUser(stored), profile: profileFromLeaderboard(leaderboard, publicAuthUser(stored)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
  if (counted) rebuildLeaderboardPlayers(data);
  saveChaseLeaderboard(data);
  const leaderboard = publicChaseLeaderboard(data);
  io.emit('chase-leaderboard-updated', leaderboard);
  res.json({ ok: true, counted, run, leaderboard });
});

app.get('/api/lol-leaderboard', async (_req, res) => {
  try {
    res.json({ leaderboard: await refreshLinkedRiotScores() });
  } catch {
    res.json({ leaderboard: publicLolLeaderboard(loadLolLeaderboard()) });
  }
});

app.get('/api/lol-account', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });
  const stored = findStoredUser(user.username);
  res.json({ ok: true, riot: publicRiotLink(stored) });
});

app.post('/api/lol-account/link', async (req, res) => {
  const current = authUser(req);
  if (!current) return res.status(401).json({ error: 'login required' });
  const gameName = cleanRiotPart(req.body?.gameName, 32);
  const tagLine = cleanRiotPart(req.body?.tagLine, 12);
  const region = cleanRiotRegion(req.body?.region);
  if (!gameName || !tagLine) return res.status(400).json({ error: 'Riot ID and tag are required' });
  const users = loadAuthUsers();
  const stored = users.users.find(item => item.username.toLowerCase() === current.username.toLowerCase());
  if (!stored) return res.status(404).json({ error: 'profile not found' });
  try {
    stored.riot = { gameName, tagLine, region, linkedAt: Date.now(), lastSyncedAt: 0 };
    await syncLolScoreForUser(stored, { force: true });
    saveAuthUsers(users);
    const leaderboard = publicLolLeaderboard(loadLolLeaderboard());
    io.emit('lol-leaderboard-updated', leaderboard);
    res.json({ ok: true, riot: publicRiotLink(stored), leaderboard });
  } catch (err) {
    saveAuthUsers(users);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/lol-account/refresh', async (req, res) => {
  const current = authUser(req);
  if (!current) return res.status(401).json({ error: 'login required' });
  const users = loadAuthUsers();
  const stored = users.users.find(item => item.username.toLowerCase() === current.username.toLowerCase());
  if (!stored?.riot?.gameName) return res.status(400).json({ error: 'link a Riot account first' });
  try {
    await syncLolScoreForUser(stored, { force: true });
    saveAuthUsers(users);
    const leaderboard = publicLolLeaderboard(loadLolLeaderboard());
    io.emit('lol-leaderboard-updated', leaderboard);
    res.json({ ok: true, riot: publicRiotLink(stored), leaderboard });
  } catch (err) {
    saveAuthUsers(users);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/lol-leaderboard/score', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });
  const gain = Math.max(-9999, Math.min(9999, Math.floor(Number(req.body?.gain) || 0)));
  const data = loadLolLeaderboard();
  const weekStart = startOfWeekMs();
  const player = cleanPlayerName(user.username);
  data.scores = Array.isArray(data.scores) ? data.scores : [];
  const existing = data.scores.find(score => Number(score.weekStart) === weekStart && cleanPlayerName(score.player).toLowerCase() === player.toLowerCase());
  if (existing) {
    existing.gain = gain;
    existing.updatedAt = Date.now();
  } else {
    data.scores.push({
      id: `lol-${weekStart}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      player,
      weekStart,
      gain,
      updatedAt: Date.now(),
    });
  }
  saveLolLeaderboard(data);
  const leaderboard = publicLolLeaderboard(data);
  io.emit('lol-leaderboard-updated', leaderboard);
  res.json({ ok: true, leaderboard });
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

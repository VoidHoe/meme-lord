require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { createRouter } = require('./router');
const { resolveMedia } = require('./resolveMedia');
const { checkSendAuth } = require('./sendAuth');
const db = require('./db');
const economy = require('./economy');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Servir les fichiers audio et media proxiés
app.use('/audio', express.static(path.join(__dirname, 'audio_cache')));
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
purgeStaleCache(path.join(__dirname, 'audio_cache'));
purgeStaleCache(path.join(__dirname, 'media_cache'));

const router = createRouter(io);

io.on('connection', (socket) => {
  console.log(`[socket] client connecté: ${socket.id}`);

  socket.on('register', (discordUsername) => {
    socket.discordUsername = discordUsername;
    console.log(`[socket] ${discordUsername} enregistré (${socket.id})`);
  });

  // Reaction relay: receiver fires an emoji back at whoever dropped on them.
  // Credits the dropper +5 Clout the first time each unique reactor reacts to a drop.
  socket.on('react', async ({ from, to, dropId, emoji }) => {
    if (!to || !emoji) return;
    let res = { credited: false, clout: null, rank: null };
    try {
      res = await economy.creditReaction(dropId, from, to);
    } catch (e) {
      console.error('[socket] react error:', e.message);
    }
    io.sockets.sockets.forEach((s) => {
      if (s.discordUsername === to) {
        s.emit('reaction', { from, emoji });
        if (res.credited) s.emit('clout-update', { clout: res.clout, rank: res.rank });
      }
    });
  });

  socket.on('disconnect', () => {
    console.log(`[socket] ${socket.discordUsername || socket.id} déconnecté`);
  });
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

// Clout economy: player state (auto-creates the player).
app.get('/api/player', async (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ error: 'username requis' });
  const p = await economy.getPlayer(username);
  res.json({
    username: p.username,
    clout: p.clout,
    totalEarned: p.total_earned,
    rank: economy.rankFor(p.total_earned),
    unlocks: p.unlocks,
  });
});

// Clout economy: spend Clout to unlock an effect/size.
app.post('/api/unlock', async (req, res) => {
  const { username, itemId } = req.body || {};
  if (!username || !itemId) return res.status(400).json({ error: 'username et itemId requis' });
  const result = await economy.unlockItem(username, itemId);
  res.json(result);
});

// Upload media direct depuis l'overlay app (images, GIFs, vidéos)
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
  const { media, mediaUrl, audio, effects, target, caption, positionX, positionY,
          loop, loopDuration, loopTimes, trimStart, trimEnd, size, from } = req.body;

  // La page mobile envoie une URL brute (mediaUrl) ; on la résout côté serveur.
  // L'app desktop envoie déjà un objet `media` résolu → on n'y touche pas.
  let resolved = media || null;
  if (!resolved && mediaUrl) {
    try { resolved = await resolveMedia(mediaUrl); }
    catch (e) { console.error('[api] resolveMedia échec:', e.message); }
  }

  if (!resolved && !audio) return res.status(400).json({ error: 'media ou audio requis' });

  // Economy: if `from` is present, run accounting (strip/downgrade + debit/credit).
  // NEVER block the drop on economy — fall back to the original effects/size.
  const dropId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let outEffects = effects || [];
  let outSize = size || 'm';
  let r = null;
  if (from) {
    try {
      r = await economy.applyDrop(from, effects || [], size || 'm');
      outEffects = r.effects;
      outSize = r.size;
    } catch (e) {
      console.error('[api] applyDrop error:', e.message);
    }
  }

  router.dispatch({
    media:        resolved  || null,
    audio:        audio     || null,
    effects:      outEffects,
    target:       target    || null,
    caption:      caption   || null,
    positionX:    positionX ?? null,
    positionY:    positionY ?? null,
    loop:         loop      ?? false,
    loopDuration: loopDuration || null,
    loopTimes:    loopTimes || null,
    trimStart:    trimStart ?? null,
    trimEnd:      trimEnd ?? null,
    size:         outSize,
    from:         from      || null,
    dropId,
  });

  console.log(`[api] drop reçu:`, JSON.stringify(req.body));
  res.json({ ok: true, clout: r?.clout ?? null, rank: r?.rank ?? null });
});

// Upload audio direct depuis l'overlay app
app.post('/api/upload-audio', express.raw({ type: 'audio/*', limit: '10mb' }), (req, res) => {
  try {
    const ext = (req.get('Content-Type') || '').includes('webm') ? 'webm' : 'mp3';
    const filename = `drop-${Date.now()}.${ext}`;
    const audioDir = path.join(__dirname, 'audio_cache');
    fs.mkdirSync(audioDir, { recursive: true });
    const filepath = path.join(audioDir, filename);
    fs.writeFileSync(filepath, req.body);
    setTimeout(() => { try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch {} }, 5 * 60 * 1000);
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

  // Init economy DB (no-op when DATABASE_URL is unset).
  db.init()
    .then((ok) => {
      console.log(`[economy] ${ok ? 'enabled (Postgres ready)' : 'disabled (no DATABASE_URL)'}`);
    })
    .catch((e) => {
      console.error('[economy] init failed, economy degraded:', e.message);
    });

  // Start bot if available
  try {
    const { startBot } = require('./bot');
    startBot(router);
  } catch (e) {
    console.warn('[server] bot not available:', e.message);
  }
});

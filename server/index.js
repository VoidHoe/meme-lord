require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { createRouter } = require('./router');
const { resolveMedia } = require('./resolveMedia');
const { checkSendAuth } = require('./sendAuth');

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
  const { media, mediaUrl, audio, effects, target, caption, captionTop, captionBottom, fadeInDuration, fadeOutDuration, positionX, positionY,
          loop, loopDuration, loopTimes, trimStart, trimEnd, size, from } = req.body;

  // La page mobile envoie une URL brute (mediaUrl) ; on la résout côté serveur.
  // L'app desktop envoie déjà un objet `media` résolu → on n'y touche pas.
  let resolved = media || null;
  if (!resolved && mediaUrl) {
    try { resolved = await resolveMedia(mediaUrl); }
    catch (e) { console.error('[api] resolveMedia échec:', e.message); }
  }

  if (!resolved && !audio) return res.status(400).json({ error: 'media ou audio requis' });

  router.dispatch({
    media:        resolved  || null,
    audio:        audio     || null,
    effects:      effects   || [],
    target:       target    || null,
    caption:      caption   || null,
    captionTop:   captionTop    || null,
    captionBottom: captionBottom || null,
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
  });

  console.log(`[api] drop reçu:`, JSON.stringify(req.body));
  res.json({ ok: true });
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

  // Start bot if available
  try {
    const { startBot } = require('./bot');
    startBot(router);
  } catch (e) {
    console.warn('[server] bot not available:', e.message);
  }
});

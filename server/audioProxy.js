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

    // Détecter l'extension depuis le Content-Type de la réponse (plus fiable que l'URL)
    const ct = response.headers.get('content-type') || '';
    let ext = 'mp3'; // fallback
    if (ct.includes('webm'))       ext = 'webm';
    else if (ct.includes('ogg'))   ext = 'ogg';
    else if (ct.includes('wav'))   ext = 'wav';
    else if (ct.includes('mp4'))   ext = 'mp4';
    else if (originalUrl.includes('.webm')) ext = 'webm';
    else if (originalUrl.includes('.ogg'))  ext = 'ogg';
    else if (originalUrl.includes('.wav'))  ext = 'wav';
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

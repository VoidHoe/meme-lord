const { Client, GatewayIntentBits } = require('discord.js');
const { isValidSound } = require('./sounds');
const { resolveAudioUrl } = require('./audioProxy');
const { resolveMedia } = require('./resolveMedia');

const MEDAL_RE = /https?:\/\/(?:www\.)?medal\.tv\/(?:games\/[^/\s]+\/)?clips?\/[\w-]+(?:\?[^\s]*)?/i;
const YOUTUBE_RE = /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)[\w-]+/;
const TIKTOK_RE = /https?:\/\/(www\.)?tiktok\.com\/.+/;
const DIRECT_MEDIA_RE = /https?:\/\/.+\.(jpg|jpeg|png|gif|webp|mp4|webm)(\?.*)?$/i;
const VOICE_MESSAGE_FLAG = 8192;
const EFFECT_NAMES = ['shake', 'spin', 'bounce', 'flip', 'fade'];

// Extrait les mots d'effet du texte, le reste devient caption
function parseTextEffects(content) {
  if (!content || content.startsWith('/')) return { effects: [], caption: null };

  const words = content.split(/\s+/);
  const effects = [];
  const captionWords = [];

  for (const word of words) {
    const lower = word.toLowerCase();
    if (EFFECT_NAMES.includes(lower)) {
      effects.push(lower);
    } else if (word.match(/^https?:\/\//)) {
      // Ignorer les URLs (liens Tenor/Giphy/etc.)
    } else if (!word.match(/^<@[!&]?\d+>$/)) {
      // Ignorer les mentions Discord brutes (<@123456>)
      captionWords.push(word);
    }
  }

  const caption = captionWords.join(' ').trim() || null;
  return { effects, caption };
}

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
      return { media, audio, effects: [], target, caption: null };
    }
    return null;
  }

  // Commande /react
  if (content.startsWith('/react')) {
    const emoji = content.replace('/react', '').trim();
    if (emoji) {
      media = { type: 'emoji', url: emoji };
      return { media, audio, effects: [], target, caption: null };
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
      // webm sans dimensions = audio-only (ex: enregistrement micro)
      if (ct.includes('webm') && !att.width && !att.height) {
        audio = { type: 'voice', url: att.url };
      } else {
        media = { type: 'video', url: att.url };
      }
      continue;
    }
  }

  // GIFs depuis le picker Discord (Tenor, Giphy) → envoyés comme embeds
  if (!media && (message.embeds?.length || 0) > 0) {
    for (const embed of message.embeds) {
      if (embed.video?.url) {
        // gifv embed : utiliser le mp4 animé directement (loop géré dans l'overlay)
        const vidUrl = embed.video.proxy_url || embed.video.url;
        media = { type: 'video', url: vidUrl };
        break;
      }
      if (embed.image?.url) {
        media = { type: 'image', url: embed.image.proxyURL || embed.image.url };
        break;
      }
    }
  }

  if (media || audio) {
    // Extraire effets et caption depuis le texte
    const { effects, caption } = parseTextEffects(content);
    return { media, audio, effects, target, caption };
  }

  // URLs dans le contenu
  if (MEDAL_RE.test(content)) {
    const url = content.match(MEDAL_RE)[0];
    return { media: { type: 'medal', url }, audio: null, effects: [], target, caption: null };
  }
  if (YOUTUBE_RE.test(content)) {
    const url = content.match(YOUTUBE_RE)[0];
    return { media: { type: 'youtube', url }, audio: null, effects: [], target, caption: null };
  }
  if (TIKTOK_RE.test(content)) {
    const url = content.match(TIKTOK_RE)[0];
    return { media: { type: 'tiktok', url }, audio: null, effects: [], target, caption: null };
  }
  if (DIRECT_MEDIA_RE.test(content)) {
    const url = content.match(DIRECT_MEDIA_RE)[0];
    const ext = url.split('.').pop().split('?')[0].toLowerCase();
    const type = ext === 'gif' ? 'gif' : ['mp4', 'webm'].includes(ext) ? 'video' : 'image';
    return { media: { type, url }, audio: null, effects: [], target, caption: null };
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

    const publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

    if (event.audio?.type === 'voice') {
      event.audio.url = await resolveAudioUrl(event.audio.url, publicUrl);
    }

    if (event.media?.type === 'medal') {
      try {
        event.media = await resolveMedia(event.media.url);
      } catch (error) {
        console.error('[bot] medal resolve failed:', error.message);
        return;
      }
    }

    // Réponse à un message GIF + voice note → combiner les deux
    if (event.audio && !event.media && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refEvent = parseMessage(refMsg);
        if (refEvent?.media) event.media = refEvent.media;
      } catch {}
    }

    console.log(`[bot] drop reçu:`, JSON.stringify(event));
    router.dispatch(event);
  });

  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('[bot] Erreur de connexion:', err.message);
  });
}

module.exports = { startBot, parseMessage };

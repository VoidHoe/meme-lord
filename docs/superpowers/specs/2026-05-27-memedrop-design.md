# MemeDrop Clone — Design Spec
**Date:** 2026-05-27  
**Status:** Approved

---

## Overview

App Windows + bot Discord qui affiche des mèmes, GIFs, vidéos et sons en overlay sur l'écran des joueurs en temps réel. Alternative open-source et extensible à memedrop.fr, avec support audio avancé (voice messages + SFX library).

---

## Architecture

### Composants

```
Discord Channel (#meme-drop)
        │
        ▼
Discord Bot (discord.js)
        │
        ▼
Node.js Server + socket.io  ◄── hébergé sur Railway (free tier)
        │
        ├──► Overlay Client A (Electron — Tanguy)
        ├──► Overlay Client B (Electron — Pote1)
        └──► Overlay Client C (Electron — Pote2)
```

### Connexion

- **Mode** : Serveur central hébergé sur Railway
- **Transport** : socket.io (WebSocket avec fallback HTTP)
- **Identification client** : chaque Electron app s'enregistre avec son pseudo Discord au moment de la connexion
- **Ciblage** : broadcast par défaut, ciblage possible via `@username` Discord

---

## Commandes Discord

| Action | Résultat |
|--------|----------|
| Poster image/GIF/vidéo dans `#meme-drop` | Drop visuel → tout le monde |
| Poster image + fichier audio attaché | Drop visuel + audio simultané → tout le monde |
| Poster un voice message Discord | Audio seul → tout le monde |
| `/sound <nom>` | SFX prédéfini → tout le monde |
| `/sound <nom> @username` | SFX → cible uniquement |
| `/drop @username` + image attachée | Drop visuel → cible uniquement |
| `/react <emoji>` | Emoji géant → tout le monde |

### Parsing bot

Le bot écoute **tous les messages** dans le channel configuré (pas uniquement les slash commands). Il détecte :
- **Attachements** : image (jpg/png/gif/webp), vidéo (mp4/webm), audio (ogg/mp3/wav)
- **Voice messages Discord** : flag `voice: true` sur l'attachement
- **URLs** : YouTube, TikTok, Twitter/X, liens media directs
- **Slash commands** : `/sound`, `/drop`, `/react`
- **Mentions** : `@username` pour le ciblage

---

## Overlay Electron

### Fenêtre principale (overlay)

- Transparente (`transparent: true`)
- Toujours au-dessus (`alwaysOnTop: true`, level `screen-saver`)
- Click-through (`setIgnoreMouseEvents(true)`)
- Plein écran, sans cadre (`frame: false`, `fullscreen: true`)
- Pas dans la barre des tâches (`skipTaskbar: true`)

### Affichage media

- **Images / GIFs** : balise `<img>`, durée configurable (défaut 5s)
- **Vidéos** : balise `<video>` autoplay muted (son via Audio API séparé)
- **YouTube / TikTok** : iframe embed avec autoplay
- **Emojis** : rendu texte géant centré

### Effets disponibles (optionnels par drop)

- `shake` — vibration rapide
- `spin` — rotation 360°
- `flip` — retournement horizontal
- `bounce` — rebond vertical
- `fade` — apparition/disparition en fondu

### Queue

- Les drops s'enchaînent sans se chevaucher
- Badge visible : nombre de drops en attente
- Durée max par drop : 10s
- En cas de ciblage, la queue est individuelle par client

---

## Audio

### Deux modes

**1. Voice messages / fichiers audio**
- Discord envoie un fichier `.ogg` / `.mp3` / `.wav` (ou voice message natif Discord)
- Le bot télécharge le fichier sur le serveur Railway et sert une URL publique temporaire (les URLs CDN Discord expirent et nécessitent une auth)
- L'overlay joue via Web Audio API (`new Audio(url).play()`)
- Si drop combiné (image + audio) : les deux jouent simultanément

**2. SFX library (bundlé dans l'app)**
- Fichiers `.mp3` dans `overlay/sounds/`
- Liste initiale : `airhorn`, `bruh`, `vine_boom`, `sad_violin`, `myname`, `gg`, `nani`, `mlg_hit`
- Commande `/sound <nom>` déclenche le SFX
- Extensible : dossier `sounds/` local scanné au démarrage

### Contrôle volume

- Volume SFX : réglable dans les settings (défaut 80%)
- Volume voix : réglable séparément (défaut 100%)
- Mute global possible (hotkey ou bouton settings)

---

## Settings UI

Fenêtre séparée (non transparente, non click-through), accessible via icône systray.

| Paramètre | Type | Défaut |
|-----------|------|--------|
| URL serveur | text | URL Railway |
| Pseudo Discord | text | — |
| Position overlay | drag & drop dans settings (pas sur l'overlay — click-through) | centre |
| Durée affichage | slider 1–10s | 5s |
| Volume SFX | slider 0–100% | 80% |
| Volume voix | slider 0–100% | 100% |
| Effets activés | toggle | on |

---

## Structure des fichiers

```
memedrop/
├── server/
│   ├── index.js          # Express + socket.io server
│   ├── bot.js            # Discord bot (discord.js)
│   ├── router.js         # Broadcast / ciblage des events
│   └── sounds.js         # Liste SFX disponibles
│
├── overlay/
│   ├── main.js           # Main process Electron
│   ├── overlay.html      # Fenêtre transparente
│   ├── overlay.js        # Queue, affichage, audio
│   ├── settings.html     # UI settings
│   ├── settings.js       # Config locale (electron-store)
│   ├── sounds/           # SFX bundlés (.mp3)
│   └── assets/           # Icônes, fonts
│
├── .env.example          # DISCORD_TOKEN, DISCORD_CHANNEL_ID, PORT
├── package.json
└── README.md
```

---

## Event Payload (socket.io)

```json
{
  "type": "drop",
  "media": {
    "type": "image | gif | video | youtube | emoji | null",
    "url": "https://...",
    "duration": 5000
  },
  "audio": {
    "type": "voice | sfx | null",
    "url": "https://... | sfx:airhorn"
  },
  "effects": ["shake"],
  "target": "Tanguy | null"
}
```

---

## Plan de build (ordre)

1. **Serveur** — socket.io server + routing broadcast/ciblage (~2h)
2. **Bot Discord** — parsing messages, attachements, voice messages (~2h)
3. **Overlay Electron** — fenêtre transparente + media + audio + queue (~3h)
4. **Settings + polish** — UI config, effets, volume, systray (~2h)

**Total estimé : ~9h de dev**

---

## Dépendances

### Server
- `discord.js` ^14
- `socket.io` ^4
- `express` ^4
- `dotenv`

### Overlay (Electron)
- `electron` ^28
- `socket.io-client` ^4
- `electron-store` (settings persistants)

---

## Hébergement

- **Railway** : free tier suffisant (500h/mois, redémarre si inactif)
- Variables d'env requises : `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `PORT`
- Le bot et le serveur socket.io tournent dans le même process

# MemeDrop Clone

Overlay Discord pour afficher des mèmes en temps réel sur les écrans de tes potes pendant les sessions gaming.

## Setup rapide

### 1. Créer le bot Discord
- https://discord.com/developers/applications → New Application → Bot
- Activer **Message Content Intent** (Settings > Bot > Privileged Gateway Intents)
- Copier le token

### 2. Inviter le bot dans ton serveur
- OAuth2 > URL Generator > Scopes: `bot` > Permissions: `Read Messages/View Channels`, `Read Message History`
- Ouvrir l'URL générée et inviter le bot

### 3. Déployer le serveur (Railway)
```bash
npm install -g @railway/cli
cd server
railway login && railway init && railway up
```
Variables d'env à configurer sur Railway :
- `DISCORD_TOKEN` — token du bot
- `DISCORD_CHANNEL_ID` — ID du channel #meme-drop (clic droit > Copier l'ID)
- `PUBLIC_URL` — URL Railway assignée (ex: https://memedrop-xxx.up.railway.app)

### 4. Lancer l'overlay
```bash
cd overlay && npm start
```
Clic droit sur l'icône tray → Settings → entrer l'URL Railway + ton pseudo Discord → Sauvegarder.

### 5. Tes potes font pareil
Ils installent l'app, configurent l'URL du serveur + leur pseudo Discord.

## Commandes Discord (dans #meme-drop)
| Action | Résultat |
|--------|----------|
| Poster une image/GIF | Drop sur tout le monde |
| Poster image + fichier audio | Drop visuel + son |
| Envoyer un voice message | Audio sur tout le monde |
| `/sound airhorn` | SFX airhorn sur tout le monde |
| `/sound airhorn @Pseudo` | SFX ciblé |
| `/react 💀` | Emoji géant sur tout le monde |

## Dev local
```bash
# Lancer le serveur
cd server && node index.js

# Lancer l'overlay  
cd overlay && npx electron .

# Tests
cd server && npx jest
```

## SFX disponibles
`airhorn` `bruh` `vine_boom` `sad_violin` `gg` `myname` `nani` `mlg_hit` `wow` `bonk`

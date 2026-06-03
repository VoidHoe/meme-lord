# MemeDrop — Mobile Quick Drop page

**Date:** 2026-06-03
**Status:** Approved design, ready for implementation plan

## Goal

Let me drop memes from my phone while away from the PC. A mobile-first web page,
served from the existing Railway server, that fires off a drop in ~5 seconds using
the same drop pipeline the desktop sender already uses.

## Scope

**In (Quick Drop):**
- Pick a photo/video from the phone gallery/camera, OR paste a URL
  (direct image/gif/mp4, TikTok, Twitter/X, YouTube)
- Add a caption
- Target everyone or one connected friend
- Pick size (S / M / L) and position (4 corners + center)
- Send
- Soft password gate on the page

**Out (desktop-only for now):**
Effects, voice record, trim timeline, GIF search, clip library, history.

## Architecture

```
Phone browser  ──HTTP──►  Express server (Railway)  ──socket.io──►  overlays
   /send page              /api/drop, /api/upload-media,
                           /api/send-auth, /api/users
```

No new infrastructure. The page is static files served by the existing server.
The drop pipeline (`router.dispatch` → socket → overlay) is unchanged.

## Components

### 1. `server/public/send/` (new)
Mobile-first single-column page: `index.html`, `app.js`, `style.css`.

UI, top to bottom:
- **Password gate** — shown only when a password is configured. On success, a flag
  is stored in `localStorage` so it isn't asked again on that phone.
- **Source** — a file picker (`accept="image/*,video/*"`, capture allowed) and a
  paste-a-URL field. Whichever the user provides is used; file takes precedence if both.
  Uploaded images show a small thumbnail preview; pasted URLs do not preview.
- **Caption** — single-line text field.
- **Target** — "Everyone" plus each connected friend, populated from `GET /api/users`,
  with a refresh affordance.
- **Size** — S / M / L chips (maps to `size` `s`/`m`/`l`).
- **Position** — 5-spot anchor (top-left, top-right, center, bottom-left, bottom-right),
  mapped to `positionX`/`positionY` using the same map as the desktop sender
  (`ANCHOR_MAP`: corners at 15/85, center at 50/50). Default: center.
- **Send** button + a status toast (idle / uploading / sending / ok / error).

### 2. `server/resolveMedia.js` (new)
The pasted-URL resolver ported from `overlay/main.js` `resolveMedia()`:
- TikTok → tikwm.com API → `{type:'video', url}`, fallback `{type:'tiktok', embed url}`
- Twitter/X → fxtwitter API → `{type:'video'|'image', url}`, fallback `{type:'twitter', embed url}`
- YouTube → `{type:'youtube', url}`
- Otherwise infer from extension → `{type:'gif'|'video'|'image', url}`

Uses Node 20 global `fetch`. The desktop copy stays as-is; this is a server-side twin.

### 3. `server/index.js` (edited, small)
- Serve `server/public/` as static, with `/send` resolving to the page.
- `POST /api/send-auth` — body `{ password }`. Compares to `process.env.SEND_PASSWORD`.
  - If `SEND_PASSWORD` is unset → `{ ok: true, required: false }` (gate skipped).
  - If set and `password` matches → `{ ok: true, required: true }`.
  - If set and `password` is missing/empty → `{ ok: false, required: true }` (used as
    the page's probe on load to decide whether to show the gate).
  - If set and `password` is wrong → `{ ok: false, required: true }`.

  The page calls this once on load with no password to learn `required`, then again
  with the entered password to unlock. No separate config endpoint.
- `/api/drop` — gains one backward-compatible field: an optional raw `mediaUrl` string.
  When `media` is absent but `mediaUrl` is present, the server resolves it via
  `resolveMedia.js` before dispatching. Desktop keeps sending its pre-resolved `media`
  object unchanged — nothing about the existing path changes.

## Data flow (sending)

1. Open `/send` → if a password is required, enter it once →
   `POST /api/send-auth` → UI unlocks, flag cached in `localStorage`.
2. Either upload a file (`POST /api/upload-media`, raw body → returns hosted URL kept
   as `media`/`mediaUrl`) **or** keep the pasted URL as `mediaUrl`.
3. `POST /api/drop` with
   `{ mediaUrl | media, caption, target, size, positionX, positionY }`.
4. Server resolves `mediaUrl` if needed → `router.dispatch` → socket → overlays render.
   Identical to the desktop path from `dispatch` onward.

## Security (soft lock)

The password gates the `/send` page UI through `/api/send-auth`. The password lives in
the Railway `SEND_PASSWORD` env var (already set), never in page source. `/api/drop`
stays as open as it is today — no desktop change, no rebuild, no friend disruption.
This stops drive-by abuse of the easy-to-find page; it does not block someone hitting
the raw API directly (accepted tradeoff). A "real lock" on `/api/drop` remains a future
option if abuse ever happens.

## Error handling

- Wrong password → inline error on the gate, stays locked.
- Upload fails / server unreachable → red toast, Send button re-enables.
- URL won't resolve → graceful fallback to embed type (same as desktop), drop still goes.
- Nothing to send (no media and no caption) → toast, send blocked.

## Testing

Jest tests in `server/tests`:
- `resolveMedia`: TikTok, Twitter, YouTube, direct image/gif/mp4, and fallback paths
  (network calls mocked).
- `/api/drop`: accepts `mediaUrl`, resolves it, and still accepts a pre-resolved `media`
  object unchanged.
- `/api/send-auth`: correct password, wrong password, and unset-env (gate skipped).

## Deploy

`SEND_PASSWORD` env var is set on Railway. After implementation:
`railway up --service memelord` (git push does not auto-deploy).

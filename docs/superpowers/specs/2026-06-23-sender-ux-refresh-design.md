# MemeDrop — Sender UX/UI Refresh (Design Spec)

**Date:** 2026-06-23
**Status:** Approved for planning
**Surfaces:** Sender window, Settings, on-screen Overlay

## 1. Goal

Make MemeDrop feel like a real app instead of a cramped scroll-form, and make
getting a screenshot in effortless. Concretely:

1. Restructure the Sender from a vertical card-stack into a **tabbed, full-canvas
   "real app" layout** (Layout B) in a larger, resizable window.
2. Make **pasting / snipping a screenshot** the primary way to load media — no
   save-to-disk + file-explorer + drag dance.
3. Give all three surfaces one cohesive, **launcher-grade "Battle.net Sci-Fi"**
   look (textured/glowing dark navy + cyan, custom fonts, angular frames).

## 2. Hard constraints (do not break)

This is a **renderer-layer rewrite** + two new capabilities. The backend contract
is preserved exactly:

- **All 23 IPC channels** stay (names + payloads unchanged): `get-settings`,
  `save-settings`, `open-settings`, `resolve-link`, `send-drop`, `upload-audio`,
  `upload-media`, `get-users`, `close-sender`, `library-list/save/save-buffer/
  delete/upload`, `get-favorites`, `save-favorite`, `delete-favorite`,
  `save-history`, `get-history`, `clear-history`, `search-gifs`,
  `check-for-updates`.
- **Compose state variables** keep the same shape: `mediaUrl, mediaIsVideo,
  trimScrubbable, videoDuration, trimStart, trimEnd, trimRepeat, selectedAnchor,
  selectedSize, activeEffects`.
- **Send payload** (the object POSTed to `/api/drop`) is byte-for-byte the same:
  `{media, audio, effects, target, caption, loop, loopDuration, loopTimes,
  trimStart, trimEnd, size, positionX, positionY}`.
- **Anchor → position map** unchanged (5 anchors → X/Y percentages).
- Socket.io drop reception → overlay unchanged.

If a change would touch any of the above, stop and reconsider.

## 3. Design system (new shared layer)

Create `overlay/theme.css` — the single source of truth, imported by
`sender.html`, `settings` (now a tab), and `overlay.html`. Today each window has
its own inline `<style>`; those get replaced by `theme.css` + a small
per-window block for layout-only rules.

**Tokens (Battle.net Sci-Fi):**
- Background: layered radial navy glow + `linear-gradient(180deg,#0a1622,#0a1019,#060a10)`,
  an SVG `feTurbulence` noise overlay (~`opacity:.5; mix-blend overlay`), faint
  scanline pattern, and an inset vignette for depth.
- Accent: cyan `#1c9eff` (hover/active `#2eb0ff`), with glow shadows
  `0 0 18px rgba(28,158,255,.5)`.
- Lines/panels: borders `#1d4a6e` / `rgba(28,158,255,.2)`, panel fills
  `rgba(6,20,34,.5)`.
- Muted text `#557da0`, body `#cfeaff`, headings `#dcefff`.
- **Angular cut corners** via `clip-path` polygons on windows, buttons, the snip
  chip, the Send button.
- **Ornate corner brackets** on the compose stage (glowing `::before/::after`).
- **Fonts bundled locally** in `overlay/assets/fonts/` (no network dependency):
  `Orbitron` (brand/wordmarks), `Rajdhani` (UI text, labels, buttons).
  `@font-face` declared in `theme.css`.
- **Motion:** pulsing glow on the Send button (`@keyframes`), hover sheen on
  primary actions, smooth tab transitions.

**Reusable component classes** (so all surfaces match): `.btn-primary`
(angular, glowing), `.btn-ghost`, `.panel`, `.field`, `.seg`/`.seg span`
(segmented), `.tab`, `.tag`/label, `.glow-frame`.

## 4. Sender — Layout B restructure

**Window (`main.js`):**
- Default size `760×580` (from `460×560`), `minWidth 640`, `minHeight 520`,
  `resizable:true`, still `frame:false`.

**Top bar (custom titlebar, `-webkit-app-region: drag`):**
- Left: crest + `MEMEDROP` wordmark (Orbitron).
- Center: **nav tabs** — `Compose · Library · GIFs · History · ⚙ Settings`.
  Tabs are `no-drag`. Active tab = cyan underline glow.
- Right: window controls (minimize, close → `close-sender`).

**Tab mechanism (`sender.js`):**
- Replace the current "slide-in view + back button" model with tab switching.
  Reuse the existing view DOM blocks (`#gif-view`, `#history-view`,
  `#library-view`) as tab panels; add a new `#settings-view` panel. A single
  `showTab(name)` toggles an `.active` panel and the active tab pill.
- Remove the per-view back buttons and the open-library/open-history/open-gif
  pill buttons in the old Media card header (the tabs do that now). The
  underlying data calls (`library-list`, `get-history`, `search-gifs`) are
  unchanged.

**Compose tab (the star):**
- **Stage**: large full-canvas preview/drop area, centered prompt
  ("Paste or Drop · Ctrl+V · Drag · Snip"), ornate glowing brackets. When media
  is loaded it shows the preview (image/video) instead of the prompt. `📸 Snip`
  chip pinned top-right of the stage.
- **Advanced strip** (slim, collapsible, above the dock): **Target** select +
  refresh, **Effects** chips (spin/fade), and **Trim** (auto-expands when a
  scrubbable video is loaded; the existing trim track/handles/repeat UI moves
  here intact). Collapsed by default for images/gifs.
- **Dock** (bottom action bar): **size** segmented `S/M/L/XL`, **position**
  3×3 anchor mini-grid, **caption** field, **Send ▸** (primary, pulsing).
- Keep the existing **Save-to-library** affordance (★) and the library/fav
  modals, restyled.

**Media input paths (preserve + extend):**
- Drag-drop file → unchanged (`uploadFile` → `upload-media` → `setMediaUrl`).
- Paste link → unchanged (`resolve-link` flow); the link field lives in/near the
  stage.
- GIF pick / history re-send / library load → unchanged data flow, now reached
  via tabs; each calls `setMediaUrl(...)` and switches to the Compose tab.

## 5. Paste-a-screenshot (Phase 1, new)

- Add a `paste` event listener (document-level) in `sender.js`.
- If `clipboardData.items` contains an image: read it as a `Blob` →
  `arrayBuffer` → call existing `window.sender.uploadMedia(buf, mimeType)` →
  receive `{url}` → `setMediaUrl(url, 'Pasted image', false)` and switch to
  Compose. No new IPC needed — reuses `upload-media`.
- Guard: ignore paste when focus is in a text field (so caption paste still types
  text), unless the clipboard item is specifically an image.

## 6. Snip hotkey + region selector (Phase 2, new)

The one genuinely new subsystem. Build after Phase 1 ships.

- **New global shortcut** in `main.js` (default `CommandOrControl+Shift+S`,
  configurable via Settings, registered/re-registered alongside the existing
  Ctrl+Shift+D logic).
- On trigger:
  1. `desktopCapturer.getSources({types:['screen'], thumbnailSize: <display res>})`
     to grab a full-resolution screenshot of the primary display.
  2. Open a new transparent, frameless, always-on-top, fullscreen
     **selector window** (`snip.html` + `snip-preload.js`) showing the frozen
     screenshot as its background.
  3. User drags a rectangle (crosshair cursor, dimmed outside the selection,
     Esc cancels).
  4. On mouse-up: crop the screenshot to the selection rect (canvas
     `drawImage`), export PNG bytes.
  5. Pipe bytes to the Sender via a new IPC (`snip-result`), which runs the same
     `upload-media` → `setMediaUrl` path used by paste. Focus the Sender on the
     Compose tab.
- **New files:** `overlay/snip.html`, `overlay/snip.js`, `overlay/snip-preload.js`.
- **New IPC:** `snip-capture` (renderer→main to request, if triggered from UI)
  and `snip-result` (main→sender to deliver the cropped image). These are
  additive; they don't alter existing channels.

## 7. Settings → Compose tab destination

- Settings becomes the `#settings-view` panel (5th nav tab, gear icon), built
  from the existing settings fields (server URL, Discord pseudo, duration, SFX
  volume, voice volume, tryhard mode, Giphy key, ElevenLabs voice, check-for-
  updates) — reusing `get-settings` / `save-settings` unchanged. Add the new
  **Snip hotkey** field here (wired in Phase 2).
- The standalone settings window is retired. The tray "Settings" menu item now
  opens the Sender focused on the Settings tab (small `main.js` tray tweak). The
  `open-settings` channel is repurposed to "show sender + Settings tab" (or
  deprecated if unused elsewhere) — keep the channel name to avoid breakage.
- `settings.html` / `settings.js` content is migrated into the tab; the old files
  can be deleted once the tab works.

## 8. Overlay — light themed touch-up

- Import `theme.css`. Re-skin the **caption** typography (Rajdhani, subtle cyan
  glow) and give incoming drops an optional **angular glow frame + entrance**
  consistent with the launcher look.
- Constraint: never obscure or letterbox the actual meme; the frame is a thin
  accent only. Tryhard-mode small-corner behavior is unchanged.

## 9. Phasing

- **Phase 1 (ship first):** `theme.css` + bundled fonts; Sender Layout B
  (window resize, top-bar tabs, Compose stage + dock + advanced strip);
  Settings-as-tab; clipboard paste; overlay touch-up. Big visible win, no new
  windows, all contracts preserved.
- **Phase 2:** snip hotkey + region selector window + Settings hotkey field.

## 10. Acceptance criteria

**Phase 1**
- Sender opens as a larger, resizable window with a launcher-style top bar and
  working `Compose / Library / GIFs / History / Settings` tabs.
- Compose shows a full-canvas stage; size, position, caption, Send sit in the
  dock; target/effects/trim in the advanced strip (trim auto-expands for videos).
- Ctrl+V with an image in the clipboard loads it into Compose and it can be sent.
- A drop sent from the new UI produces the **identical** `/api/drop` payload as
  before (verified against the send-object fields).
- Library save/load, GIF search, history re-send, favorites all still work.
- Settings tab saves/loads via the existing IPC; overlay reflects setting changes.
- All three surfaces visibly share the Battle.net Sci-Fi look; fonts render with
  no network access.

**Phase 2**
- The snip hotkey captures a region and drops the cropped image into Compose,
  ready to send, without touching the filesystem manually.
- Esc cancels the snip cleanly; the hotkey is configurable in Settings.

## 11. Out of scope

- Mobile `/send` page (untouched).
- Server / Discord bot logic, media resolution, SFX, TTS.
- Any change to the drop payload schema or socket protocol.

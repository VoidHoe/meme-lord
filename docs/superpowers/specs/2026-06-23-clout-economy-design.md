# MemeDrop — Reactions + Clout Economy (Design Spec)

**Date:** 2026-06-23
**Status:** Approved for implementation
**Scope:** Sub-projects 1 (Reactions) + 2 (Clout economy), built together.
**Out of scope (sub-project 3):** leaderboard, loot packs, power-ups beyond XL, cosmetics, seasons, daily streaks.

## 1. Goal

Make dropping a meme *earn* something. You gain **Clout** for landing drops and
(mostly) for your drops getting **reactions**; you spend Clout to permanently
unlock effects/sizes and to pay a small per-use cost for the disruptive XL drop.
Reactions also close the social loop: the receiver fires an emoji back at whoever
dropped on them.

**Prime directive:** the economy must NEVER block a meme. On any DB/economy
failure, the drop still fires; we just skip the accounting.

## 2. Architecture

- **Server** (`server/`): new Postgres layer (`db.js`) + pure economy rules
  (`economy.js`) + wiring in `index.js` (economy-aware `/api/drop`, reaction
  relay over sockets, `/api/player`, `/api/unlock`).
- **Desktop main** (`overlay/main.js`): inject `from` on drops; track the last
  dropper; reaction hotkey → picker window; IPC proxies for player/unlock;
  forward `reaction` + `clout-update` socket events to overlay/sender.
- **Reaction picker** (new `overlay/react.html` + `react.js` + `react-preload.js`):
  small focusable popup the hotkey summons.
- **Sender** (`overlay/sender.*`): Clout HUD badge; lock/unlock UI on effect &
  size chips.
- **Overlay** (`overlay/overlay.*`): render incoming reactions.

Economy degrades to a no-op when `DATABASE_URL` is unset or the DB is
unreachable, so the server still runs locally without Postgres.

## 3. Data model (Postgres)

```sql
CREATE TABLE IF NOT EXISTS players (
  username      TEXT PRIMARY KEY,
  clout         INTEGER NOT NULL DEFAULT 100,
  total_earned  INTEGER NOT NULL DEFAULT 100,
  unlocks       JSONB   NOT NULL DEFAULT '["spin","fade","size-s","size-m"]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drop_reactions (
  drop_id  TEXT NOT NULL,
  reactor  TEXT NOT NULL,
  PRIMARY KEY (drop_id, reactor)
);
```

A new player is auto-created on first sight with `clout=100`,
`total_earned=100`, and the four free unlocks.

## 4. Economy config *(tunable constants in `economy.js`)*

- **Effect unlock costs (id → cost):** `spin` 0, `fade` 0, `drop` 50, `slide` 50,
  `zoom` 80, `flip` 80, `glitch` 150, `shake` 50, `pulse` 50, `wobble` 80,
  `spin-loop` 80, `rainbow` 120, `float` 50, `slam` 200, `flash` 120, `glow` 120.
- **Size unlock costs:** `size-s` 0, `size-m` 0, `size-l` 100, `size-xl` 250.
- **Per-use sink:** XL drop costs **10** Clout each fire.
- **Earn:** land a drop **+2**; first reaction from each unique reactor on a drop **+5**.
- **Start:** `clout=100`, unlocks `["spin","fade","size-s","size-m"]`.
- **Ranks (on `total_earned`):** `0` Bronze Andy · `250` Drip Rookie ·
  `750` Certified Menace · `2000` Meme Lord · `5000` Cooked God.

## 5. Pure rules (testable, no DB) — `economy.js`

- `unlockCost(itemId)` → number | null (null = unknown item).
- `rankFor(totalEarned)` → string.
- `computeDropOutcome(player, effects, size)` → `{ effects, size, perUseCost, baseCredit }`:
  - strip effects not in `player.unlocks`;
  - if `size-<size>` not unlocked, **downgrade** to the largest unlocked size
    (xl→l→m→s); never reject;
  - `perUseCost` = 10 if final size is `xl` else 0; if the player can't afford
    `perUseCost`, downgrade xl→l (so XL is gated by affordability, not an error);
  - `baseCredit` = 2.
- These are exported and unit-tested directly (no DB needed).

DB-touching wrappers (in `economy.js` using `db.js`): `getPlayer`,
`applyDrop`, `unlockItem`, `creditReaction`. Each catches DB errors and returns a
safe fallback so callers never throw.

## 6. Contract — payloads & events

**Drop (sender → main → `POST /api/drop`):** existing fields plus
`from` (your pseudo). `effects` (array) and `size` already present.

**`/api/drop` server behavior:** if `from` is present and economy is up:
`applyDrop(from, effects, size)` → strip/downgrade per §5, debit `perUseCost`,
credit `baseCredit`, persist; assign `dropId = "<ts>-<rand>"`. Dispatch the drop
event **including `from` and `dropId`** and the adjusted `effects`/`size`. Respond
`{ ok:true, clout, rank, adjusted:{effects,size} }`. On DB error or no `from`:
dispatch unchanged, respond `{ ok:true }`. **Drops are never rejected for economy
reasons** (always downgrade, never block).

**Socket events:**
- `drop` (server → overlay): now carries `from` and `dropId`.
- `react` (client → server): `{ from, to, dropId, emoji }`. Server →
  `creditReaction(dropId, from, to)`; if newly inserted, credit `to` +5, then emit
  `reaction` `{ from, emoji }` and `clout-update` `{ clout, rank }` to every socket
  whose `discordUsername === to`.
- `reaction` (server → overlay): `{ from, emoji }` → overlay shows a giant emoji.
- `clout-update` (server → client): `{ clout, rank }` → main forwards to sender.

**HTTP:**
- `GET /api/player?username=` → `{ username, clout, totalEarned, rank, unlocks }`
  (auto-creates the player).
- `POST /api/unlock` `{ username, itemId }` → `{ ok, clout, rank, unlocks }` or
  `{ error: 'insufficient' | 'unknown' | 'owned' }`.

## 7. Desktop main (`overlay/main.js`)

- `send-drop` handler: add `from: store.get('discordUsername')` to the body;
  return the server JSON (so the sender can refresh its HUD from `clout`/`rank`).
- Track `lastDropper`/`lastDropId` from incoming `drop` socket events (read
  `event.from`/`event.dropId` before forwarding to the overlay).
- Forward `reaction` socket events to the overlay; forward `clout-update` to the
  sender.
- New global shortcut `reactHotkey` (default `CommandOrControl+Shift+R`,
  configurable, '' = off) → open the reaction picker window.
- Reaction picker window: small (≈ 320×120), frameless, focusable, always-on-top,
  loads `react.html`; on open, send it `react-init { lastDropper }`. On
  `react-pick { emoji }`: emit socket `react { from: me, to: lastDropper,
  dropId: lastDropId, emoji }`, close the window. On `react-cancel`: close.
- New IPC: `get-player` → `GET /api/player?username=<me>`; `unlock-item` →
  `POST /api/unlock`. (Renderer can't call the server cross-origin; these proxy it.)
- Store defaults: add `reactHotkey: 'CommandOrControl+Shift+R'`.

## 8. Reaction picker (`overlay/react.html`, `react.js`, `react-preload.js`)

- Theme-matched small window. Shows the five reactions **💀 😂 🔥 👎 🐐** as big
  buttons; clicking sends `react-pick { emoji }`. Esc → `react-cancel`.
- If `lastDropper` is empty, show "No one to react to yet" and disable buttons.
- `react-preload.js` exposes `onInit`, `pick(emoji)`, `cancel()`.

## 9. Sender (`overlay/sender.*`)

- **Clout HUD** in the titlebar: `🪙 <clout> · <rank>`, loaded via `get-player`
  on open and refreshed on drop result + `clout-update`.
- **Locked chips:** effect & size chips render a 🔒 + cost when the item isn't in
  `unlocks`. A locked chip does NOT toggle the effect; clicking it asks
  "Unlock <name> for <cost>?" → `unlock-item` → on success, unlock the chip and
  refresh the HUD. XL shows its per-use cost as a hint.
- Size id mapping: chip `s/m/l/xl` ↔ unlock id `size-s/m/l/xl`.
- `activeEffects` may only contain unlocked effects; selecting a locked size is
  blocked until unlocked.
- Settings tab: add the **reaction hotkey** field (like the snip hotkey).

## 10. Overlay (`overlay/overlay.*`)

- `onReaction({ from, emoji })`: show a large emoji (≈ 120px) with the reactor's
  name, a quick pop-in/out animation, top-center, for ~2.5s. Independent of the
  drop queue (reactions can land anytime). Preload exposes `onReaction`.

## 11. Error handling

- DB down / no `DATABASE_URL`: economy functions no-op; drops/reactions still
  flow; HUD shows a neutral state (`clout` may be null → HUD hidden or "—").
- Insufficient Clout on unlock: `{ error:'insufficient' }` → sender toast.
- Reaction with no `lastDropper`: picker shows empty state; nothing sent.
- Double reaction: `drop_reactions` PK dedupes → no extra Clout.

## 12. Testing

- **Server unit tests** (`server/tests/economy.test.js`, jest): `unlockCost`,
  `rankFor`, `computeDropOutcome` (strip locked effects, downgrade locked size,
  XL affordability downgrade, base credit) — all pure, no DB.
- **Manual two-client:** drop with `from` → balance moves; locked effect stripped;
  XL debits/downgrades; unlock flow; react via hotkey → dropper sees emoji + gains
  +5; double-react gives nothing.

## 13. Railway / ops

- Add a **Railway Postgres** database to the project; Railway injects
  `DATABASE_URL`. Server reads it; on boot it runs the `CREATE TABLE IF NOT
  EXISTS` migrations. Redeploy with `railway up --service memelord`.
- `pg` added to `server/package.json`.

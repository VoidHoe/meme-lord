// Clout economy: pure rules (unit-testable, no DB) + DB-touching wrappers.
//
// The pure functions (COSTS, unlockCost, rankFor, computeDropOutcome) never touch
// the database and are tested directly. The async wrappers use db.js and NEVER
// throw — on any DB error (including the economy being disabled) they return a
// safe fallback so the meme always fires.

const db = require('./db');

// ---------------------------------------------------------------------------
// Config / constants (tunable) — spec §4
// ---------------------------------------------------------------------------

const XL_PER_USE = 10;       // Clout cost each time an XL drop fires.
const DROP_CREDIT = 2;       // Clout earned for landing a drop.
const REACTION_CREDIT = 5;   // Clout earned per unique reactor on your drop.
const START_CLOUT = 100;
const START_UNLOCKS = ['spin', 'fade', 'size-s', 'size-m'];

// Effect + size unlock costs (id → cost). 0 = free / always unlocked.
const UNLOCK_COSTS = {
  // effects
  spin: 0,
  fade: 0,
  drop: 50,
  slide: 50,
  zoom: 80,
  flip: 80,
  glitch: 150,
  shake: 50,
  pulse: 50,
  wobble: 80,
  'spin-loop': 80,
  rainbow: 120,
  float: 50,
  slam: 200,
  flash: 120,
  glow: 120,
  // sizes
  'size-s': 0,
  'size-m': 0,
  'size-l': 100,
  'size-xl': 250,
};

// Ranks keyed on total_earned, ascending by threshold.
const RANKS = [
  { threshold: 0,    name: 'Bronze Andy' },
  { threshold: 250,  name: 'Drip Rookie' },
  { threshold: 750,  name: 'Certified Menace' },
  { threshold: 2000, name: 'Meme Lord' },
  { threshold: 5000, name: 'Cooked God' },
];

const COSTS = {
  XL_PER_USE,
  DROP_CREDIT,
  REACTION_CREDIT,
  START_CLOUT,
  START_UNLOCKS,
  UNLOCK_COSTS,
  RANKS,
};

// Size ordering, largest → smallest, for downgrade logic.
const SIZE_ORDER = ['xl', 'l', 'm', 's'];

// ---------------------------------------------------------------------------
// Pure rules (no DB)
// ---------------------------------------------------------------------------

// Cost to unlock an item id, or null if the item is unknown.
function unlockCost(itemId) {
  if (Object.prototype.hasOwnProperty.call(UNLOCK_COSTS, itemId)) {
    return UNLOCK_COSTS[itemId];
  }
  return null;
}

// Highest rank whose threshold <= totalEarned.
function rankFor(totalEarned) {
  let name = RANKS[0].name;
  for (const r of RANKS) {
    if (totalEarned >= r.threshold) name = r.name;
    else break;
  }
  return name;
}

// Given a player row, requested effects and size, compute the adjusted outcome.
// - strips effects not unlocked
// - downgrades a locked size to the largest unlocked one (xl→l→m→s)
// - XL costs 10/use; if unaffordable, downgrade xl→l (gated by money, never error)
// Returns { effects, size, perUseCost, baseCredit }.
function computeDropOutcome(player, effects, size) {
  const unlocks = (player && Array.isArray(player.unlocks)) ? player.unlocks : [];
  const clout = (player && typeof player.clout === 'number') ? player.clout : 0;

  // Strip locked effects.
  const reqEffects = Array.isArray(effects) ? effects : [];
  const outEffects = reqEffects.filter((e) => unlocks.includes(e));

  // Resolve size: if locked, downgrade to largest unlocked size.
  let outSize = (typeof size === 'string' && size) ? size : 'm';
  if (!unlocks.includes(`size-${outSize}`)) {
    outSize = 's'; // fallback if nothing matches (size-s is always free in defaults)
    for (const s of SIZE_ORDER) {
      if (unlocks.includes(`size-${s}`)) { outSize = s; break; }
    }
  }

  // Per-use XL cost, gated by affordability.
  let perUseCost = outSize === 'xl' ? XL_PER_USE : 0;
  if (perUseCost > 0 && clout < perUseCost) {
    outSize = 'l';
    perUseCost = 0;
  }

  return { effects: outEffects, size: outSize, perUseCost, baseCredit: DROP_CREDIT };
}

// ---------------------------------------------------------------------------
// DB-touching wrappers — never throw
// ---------------------------------------------------------------------------

// Shape a players row for callers (defensive about types).
function shapePlayer(row) {
  let unlocks = row.unlocks;
  if (typeof unlocks === 'string') {
    try { unlocks = JSON.parse(unlocks); } catch { unlocks = []; }
  }
  if (!Array.isArray(unlocks)) unlocks = [];
  return {
    username: row.username,
    clout: row.clout,
    total_earned: row.total_earned,
    unlocks,
  };
}

// Fetch (or auto-create) a player row. Returns a default-shaped object on DB error.
async function getPlayer(username) {
  const fallback = {
    username,
    clout: START_CLOUT,
    total_earned: START_CLOUT,
    unlocks: [...START_UNLOCKS],
  };
  try {
    const res = await db.query(
      `INSERT INTO players (username) VALUES ($1)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING username, clout, total_earned, unlocks`,
      [username]
    );
    return shapePlayer(res.rows[0]);
  } catch (err) {
    if (!(err instanceof db.EconomyDisabledError)) {
      console.error('[economy] getPlayer error:', err.message);
    }
    return fallback;
  }
}

// Apply a drop: compute outcome, debit perUseCost, credit baseCredit, persist.
// Returns { effects, size, clout, rank }. On DB error returns the (possibly
// un-adjusted) effects/size with clout/rank = null.
async function applyDrop(username, effects, size) {
  try {
    const player = await getPlayer(username);
    const outcome = computeDropOutcome(player, effects, size);

    const newClout = player.clout - outcome.perUseCost + outcome.baseCredit;
    const newEarned = player.total_earned + outcome.baseCredit;

    const res = await db.query(
      `UPDATE players
         SET clout = $2, total_earned = $3, updated_at = now()
       WHERE username = $1
       RETURNING clout, total_earned`,
      [username, newClout, newEarned]
    );
    const row = res.rows[0];
    return {
      effects: outcome.effects,
      size: outcome.size,
      clout: row.clout,
      rank: rankFor(row.total_earned),
    };
  } catch (err) {
    if (!(err instanceof db.EconomyDisabledError)) {
      console.error('[economy] applyDrop error:', err.message);
    }
    // Economy down: dispatch unchanged.
    return { effects, size, clout: null, rank: null };
  }
}

// Spend Clout to permanently unlock an item.
// Returns { ok, clout, rank, unlocks } or { error: 'unknown'|'owned'|'insufficient' }.
async function unlockItem(username, itemId) {
  const cost = unlockCost(itemId);
  if (cost === null) return { error: 'unknown' };

  try {
    const player = await getPlayer(username);
    if (player.unlocks.includes(itemId)) return { error: 'owned' };
    if (player.clout < cost) return { error: 'insufficient' };

    const newClout = player.clout - cost;
    const newUnlocks = [...player.unlocks, itemId];

    const res = await db.query(
      `UPDATE players
         SET clout = $2, unlocks = $3::jsonb, updated_at = now()
       WHERE username = $1
       RETURNING clout, total_earned, unlocks`,
      [username, newClout, JSON.stringify(newUnlocks)]
    );
    const row = res.rows[0];
    const shaped = shapePlayer({ username, ...row });
    return {
      ok: true,
      clout: shaped.clout,
      rank: rankFor(row.total_earned),
      unlocks: shaped.unlocks,
    };
  } catch (err) {
    if (!(err instanceof db.EconomyDisabledError)) {
      console.error('[economy] unlockItem error:', err.message);
    }
    // Treat economy-down as insufficient so the UI shows a neutral failure.
    return { error: 'insufficient' };
  }
}

// Credit a unique reaction. Inserts (drop_id, reactor); only the first insert
// credits the dropper +5. Returns { credited, clout, rank }.
async function creditReaction(dropId, reactor, dropper) {
  const fallback = { credited: false, clout: null, rank: null };
  if (!dropId || !reactor || !dropper) return fallback;

  try {
    const ins = await db.query(
      `INSERT INTO drop_reactions (drop_id, reactor) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [dropId, reactor]
    );
    if (ins.rowCount === 0) return fallback; // already reacted

    // Ensure dropper exists, then credit +5.
    await getPlayer(dropper);
    const res = await db.query(
      `UPDATE players
         SET clout = clout + $2, total_earned = total_earned + $2, updated_at = now()
       WHERE username = $1
       RETURNING clout, total_earned`,
      [dropper, REACTION_CREDIT]
    );
    const row = res.rows[0];
    return { credited: true, clout: row.clout, rank: rankFor(row.total_earned) };
  } catch (err) {
    if (!(err instanceof db.EconomyDisabledError)) {
      console.error('[economy] creditReaction error:', err.message);
    }
    return fallback;
  }
}

module.exports = {
  // constants
  COSTS,
  // pure rules
  unlockCost,
  rankFor,
  computeDropOutcome,
  // db wrappers
  getPlayer,
  applyDrop,
  unlockItem,
  creditReaction,
};

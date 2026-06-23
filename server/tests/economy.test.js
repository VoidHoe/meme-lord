// Pure-rules tests for the Clout economy (no DB).
const { unlockCost, rankFor, computeDropOutcome, COSTS } = require('../economy');

describe('unlockCost', () => {
  test('known free items → 0', () => {
    expect(unlockCost('spin')).toBe(0);
    expect(unlockCost('size-s')).toBe(0);
  });

  test('known paid items → their cost', () => {
    expect(unlockCost('glitch')).toBe(150);
    expect(unlockCost('size-xl')).toBe(250);
    expect(unlockCost('slam')).toBe(200);
  });

  test('unknown item → null', () => {
    expect(unlockCost('nope')).toBeNull();
    expect(unlockCost('')).toBeNull();
    expect(unlockCost('size-xxl')).toBeNull();
  });
});

describe('rankFor', () => {
  test('below first threshold still Bronze Andy', () => {
    expect(rankFor(0)).toBe('Bronze Andy');
    expect(rankFor(100)).toBe('Bronze Andy');
    expect(rankFor(249)).toBe('Bronze Andy');
  });

  test('each threshold boundary', () => {
    expect(rankFor(250)).toBe('Drip Rookie');
    expect(rankFor(749)).toBe('Drip Rookie');
    expect(rankFor(750)).toBe('Certified Menace');
    expect(rankFor(1999)).toBe('Certified Menace');
    expect(rankFor(2000)).toBe('Meme Lord');
    expect(rankFor(4999)).toBe('Meme Lord');
    expect(rankFor(5000)).toBe('Cooked God');
    expect(rankFor(999999)).toBe('Cooked God');
  });
});

describe('computeDropOutcome', () => {
  const defaultPlayer = (overrides = {}) => ({
    clout: 100,
    total_earned: 100,
    unlocks: ['spin', 'fade', 'size-s', 'size-m'],
    ...overrides,
  });

  test('strips effects not unlocked, keeps unlocked', () => {
    const out = computeDropOutcome(defaultPlayer(), ['spin', 'glitch', 'fade'], 'm');
    expect(out.effects).toEqual(['spin', 'fade']);
  });

  test('baseCredit is always 2', () => {
    const out = computeDropOutcome(defaultPlayer(), [], 'm');
    expect(out.baseCredit).toBe(2);
    expect(COSTS.DROP_CREDIT).toBe(2);
  });

  test('keeps an unlocked size as-is', () => {
    const out = computeDropOutcome(defaultPlayer(), [], 's');
    expect(out.size).toBe('s');
    expect(out.perUseCost).toBe(0);
  });

  test('downgrades a locked size to the largest unlocked one', () => {
    // Default unlocks top out at size-m, so xl → m and l → m.
    expect(computeDropOutcome(defaultPlayer(), [], 'xl').size).toBe('m');
    expect(computeDropOutcome(defaultPlayer(), [], 'l').size).toBe('m');
  });

  test('downgrades locked size to s when only s is unlocked', () => {
    const p = defaultPlayer({ unlocks: ['spin', 'size-s'] });
    expect(computeDropOutcome(p, [], 'l').size).toBe('s');
  });

  test('XL with size unlocked and affordable → perUseCost 10', () => {
    const p = defaultPlayer({ clout: 100, unlocks: ['size-s', 'size-m', 'size-l', 'size-xl'] });
    const out = computeDropOutcome(p, [], 'xl');
    expect(out.size).toBe('xl');
    expect(out.perUseCost).toBe(10);
  });

  test('XL unlocked but clout < 10 → downgrade to L, perUseCost 0', () => {
    const p = defaultPlayer({ clout: 5, unlocks: ['size-s', 'size-m', 'size-l', 'size-xl'] });
    const out = computeDropOutcome(p, [], 'xl');
    expect(out.size).toBe('l');
    expect(out.perUseCost).toBe(0);
  });

  test('exactly 10 clout can afford XL', () => {
    const p = defaultPlayer({ clout: 10, unlocks: ['size-s', 'size-m', 'size-l', 'size-xl'] });
    const out = computeDropOutcome(p, [], 'xl');
    expect(out.size).toBe('xl');
    expect(out.perUseCost).toBe(10);
  });

  test('handles missing/garbage input defensively', () => {
    const out = computeDropOutcome({ unlocks: ['size-s', 'size-m'], clout: 0 }, undefined, undefined);
    expect(out.effects).toEqual([]);
    expect(out.size).toBe('m'); // requested default 'm' is unlocked
    expect(out.baseCredit).toBe(2);
  });
});

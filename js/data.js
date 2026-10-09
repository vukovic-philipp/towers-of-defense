// Static game data: world size, balls, towers, tech tree, wave formulas.


export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// "Goblins" are physics balls. r = radius (mass ~ r^2), drag = air-drag multiplier (lower = falls faster).
export const GOBLINS = [
  { name: 'Grunt',   hp: 1,    bounty: 1, leak: 1,  r: 6,  drag: 1,    color: '#4ade80' },
  { name: 'Scout',   hp: 0.55, bounty: 1, leak: 1,  r: 5,  drag: 0.65, color: '#facc15' },
  { name: 'Brute',   hp: 4,    bounty: 3, leak: 2,  r: 9,  drag: 1.25, color: '#fb923c' },
  { name: 'Warlord', hp: 45,   bounty: 40, leak: 10, r: 13, drag: 1.4,  color: '#e879f9' },
];

// Towers are free-placed anywhere, never collide with balls. push/blast = physics impulses (px/s).
export const TOWERS = {
  arrow:  { name: 'Archer', color: '#f6c453', cost: 100, range: 100, dmg: 9,  rate: 2.6, push: 25,
            desc: 'Fast shots, nudges balls' },
  cannon: { name: 'Cannon', color: '#f08a5d', cost: 220, range: 90,  dmg: 26, rate: 0.85, splash: 38, blast: 170,
            desc: 'Explosion blasts balls away' },
  frost:  { name: 'Frost',  color: '#7cc7ff', cost: 160, range: 80,  dmg: 2,  rate: 1.3, slow: 0.35,
            desc: 'Slows everything in range', unlock: 'frost' },
  tesla:  { name: 'Tesla',  color: '#c9a7ff', cost: 380, range: 92,  dmg: 20, rate: 1.25, chain: 3,
            desc: 'Chain lightning, jolts balls', unlock: 'tesla' },
};
export const TOWER_ORDER = ['arrow', 'cannon', 'frost', 'tesla'];
export const MAX_LEVEL = 5;
export const TARGET_MODES = ['Furthest', 'Strongest', 'Closest'];
export const upgradeCost = (type, lvl) => Math.round(TOWERS[type].cost * (0.7 + 0.5 * lvl));
export const SELL_RATIO = 0.7;
export const PRICE_CREEP = 0.07;      // each owned tower raises the price of the next by 7%
export const TOWER_SPACING = 26;      // min distance between towers
export const START_GOLD = 210;

// ---- waves (infinite) ----
export const MAX_ON_WAVE = 300;
export const waveCount = n => Math.min(MAX_ON_WAVE, Math.floor(8 + 5 * n + 0.12 * n * n));
export const waveHp = n => 10 * Math.pow(1.13, n - 1);
export const waveBounty = n => 1.4 + 0.05 * n;

/** Spawn order for wave n as goblin type indices. Deterministic per wave. */
export function waveList(n) {
  const cnt = waveCount(n), list = new Uint8Array(cnt), r = mulberry32(n * 7919 + 13);
  const pBrute = n >= 6 ? Math.min(0.35, (n - 5) * 0.02) : 0;
  const pScout = n >= 3 ? Math.min(0.3, (n - 2) * 0.03) : 0;
  for (let i = 0; i < cnt; i++) {
    const x = r();
    list[i] = x < pBrute ? 2 : x < pBrute + pScout ? 1 : 0;
  }
  const bosses = n % 10 === 0 ? n / 10 : 0;
  for (let b = 0; b < bosses; b++) list[Math.floor((b + 1) * cnt / (bosses + 1))] = 3;
  return list;
}

// ---- tech tree (persistent, bought with shards) ----
export const BRANCHES = ['Economy', 'Offense', 'Arsenal', 'Defense'];
export const TECH = [
  { id: 'purse',    branch: 'Economy', name: 'Starting Purse',    desc: '+30 starting gold',            max: 5, base: 8,  req: [] },
  { id: 'bounty',   branch: 'Economy', name: 'Bounty Hunter',     desc: '+10% gold from kills',         max: 5, base: 14, req: ['purse'] },
  { id: 'interest', branch: 'Economy', name: 'Compound Interest', desc: '+1% of banked gold each wave', max: 5, base: 22, req: ['bounty'] },
  { id: 'dmg',      branch: 'Offense', name: 'Sharpened Steel',   desc: '+8% tower damage',             max: 5, base: 10, req: [] },
  { id: 'rate',     branch: 'Offense', name: 'Quick Hands',       desc: '+6% attack speed',             max: 5, base: 16, req: ['dmg'] },
  { id: 'crit',     branch: 'Offense', name: 'Lucky Strike',      desc: '+4% chance of double damage',  max: 5, base: 24, req: ['rate'] },
  { id: 'range',    branch: 'Arsenal', name: 'Eagle Eye',         desc: '+5% tower range',              max: 4, base: 12, req: ['dmg'] },
  { id: 'frost',    branch: 'Arsenal', name: 'Frost Tower',       desc: 'Unlocks the Frost tower',      max: 1, base: 20, req: ['dmg'] },
  { id: 'splash',   branch: 'Arsenal', name: 'Shrapnel',          desc: '+12% cannon blast radius',     max: 4, base: 18, req: ['range'] },
  { id: 'tesla',    branch: 'Arsenal', name: 'Tesla Tower',       desc: 'Unlocks the Tesla tower',      max: 1, base: 60, req: ['frost', 'rate'] },
  { id: 'lives',    branch: 'Defense', name: 'Fortified Gate',    desc: '+2 starting lives',            max: 5, base: 8,  req: [] },
  { id: 'revive',   branch: 'Defense', name: 'Last Stand',        desc: 'Once per run: refill 10 lives instead of losing', max: 1, base: 50, req: ['lives'] },
];
export const TECH_BY_ID = Object.fromEntries(TECH.map(t => [t.id, t]));
export const techCost = (node, level) => Math.ceil(node.base * Math.pow(1.55, level));

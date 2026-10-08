// Static game data: map, path, goblins, towers, tech tree, wave formulas.

export const COLS = 9, ROWS = 13, TILE = 40;
export const W = COLS * TILE, H = ROWS * TILE;

// Waypoints in tile coordinates (centre of tile). First/last are off-screen.
export const WAYPOINTS = [[-1, 1], [7, 1], [7, 4], [1, 4], [1, 7], [7, 7], [7, 10], [1, 10], [1, 13]];

const wpPx = WAYPOINTS.map(([c, r]) => [(c + 0.5) * TILE, (r + 0.5) * TILE]);
export const SEG_N = wpPx.length - 1;
export const SEG_X0 = new Float32Array(SEG_N);
export const SEG_Y0 = new Float32Array(SEG_N);
export const SEG_DX = new Float32Array(SEG_N);
export const SEG_DY = new Float32Array(SEG_N);
export const SEG_START = new Float32Array(SEG_N);
export let PATH_LEN = 0;
for (let i = 0; i < SEG_N; i++) {
  const [x0, y0] = wpPx[i], [x1, y1] = wpPx[i + 1];
  SEG_X0[i] = x0; SEG_Y0[i] = y0;
  SEG_DX[i] = Math.sign(x1 - x0); SEG_DY[i] = Math.sign(y1 - y0);
  SEG_START[i] = PATH_LEN;
  PATH_LEN += Math.abs(x1 - x0) + Math.abs(y1 - y0);
}
export const WP_PX = wpPx;

// Cells occupied by the path (not buildable).
export const PATH_CELLS = new Uint8Array(COLS * ROWS);
for (let i = 0; i < WAYPOINTS.length - 1; i++) {
  let [c, r] = WAYPOINTS[i];
  const [c1, r1] = WAYPOINTS[i + 1];
  const dc = Math.sign(c1 - c), dr = Math.sign(r1 - r);
  for (;;) {
    if (c >= 0 && c < COLS && r >= 0 && r < ROWS) PATH_CELLS[r * COLS + c] = 1;
    if (c === c1 && r === r1) break;
    c += dc; r += dr;
  }
}

export const GOBLINS = [
  { name: 'Grunt',   hp: 1,    speed: 1,    bounty: 1,  leak: 1,  r: 7,  color: '#6ab04c' },
  { name: 'Scout',   hp: 0.55, speed: 1.7,  bounty: 1,  leak: 1,  r: 6,  color: '#b8e04a' },
  { name: 'Brute',   hp: 4,    speed: 0.7,  bounty: 3,  leak: 2,  r: 10, color: '#2f8a3c' },
  { name: 'Warlord', hp: 45,   speed: 0.55, bounty: 40, leak: 10, r: 14, color: '#9b59b6' },
];
export const BASE_SPEED = 40; // px / s

export const TOWERS = {
  arrow:  { name: 'Archer', icon: '🏹', color: '#d4a24c', cost: 50,  range: 100, dmg: 9,  rate: 2.6,
            desc: 'Fast single target' },
  cannon: { name: 'Cannon', icon: '💣', color: '#7f8c8d', cost: 110, range: 88,  dmg: 26, rate: 0.85, splash: 34,
            desc: 'Splash damage' },
  frost:  { name: 'Frost',  icon: '❄️', color: '#5dade2', cost: 80,  range: 78,  dmg: 2,  rate: 1.3, slow: 0.35,
            desc: 'Slows everything in range', unlock: 'frost' },
  tesla:  { name: 'Tesla',  icon: '⚡', color: '#f4d03f', cost: 190, range: 92,  dmg: 20, rate: 1.25, chain: 3,
            desc: 'Chain lightning', unlock: 'tesla' },
};
export const TOWER_ORDER = ['arrow', 'cannon', 'frost', 'tesla'];
export const MAX_LEVEL = 5;
export const TARGET_MODES = ['First', 'Strongest', 'Closest'];
export const upgradeCost = (type, lvl) => Math.round(TOWERS[type].cost * (0.7 + 0.5 * lvl));
export const SELL_RATIO = 0.7;

// ---- waves (infinite) ----
export const MAX_ON_WAVE = 300;
export const waveCount = n => Math.min(MAX_ON_WAVE, Math.floor(8 + 5 * n + 0.12 * n * n));
export const waveHp = n => 14 * Math.pow(1.15, n - 1);
export const waveBounty = n => 1.5 + 0.07 * n;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
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

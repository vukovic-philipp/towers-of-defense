// Shared game data. Numbers here are mirrored into the GPU shaders at build time.
export const WORLD_W = 1600;
export const WORLD_H = 900;

export const MAX_ENEMIES = 4096;
export const MAX_TOWERS = 64;
export const MORTAR_FLIGHT = 0.8;

// Enemy kinds are 1..10 on the GPU (0 means "slot is free").
// armor: flat damage removed from every bullet or shell (beams, flames and burning ignore it)
export const ENEMIES = [
  null,
  { name: 'Swarmer',   radius: 4.5, speed: 72,  hp: 14,   reward: 0.45, leak: 1,  armor: 0,  color: '#f4b266', desc: 'Weak, but there are hundreds.' },
  { name: 'Grunt',     radius: 6,   speed: 56,  hp: 42,   reward: 1.1,  leak: 1,  armor: 0,  color: '#f07178', desc: 'The standard soldier.' },
  { name: 'Brute',     radius: 9.5, speed: 36,  hp: 260,  reward: 4,    leak: 3,  armor: 0,  color: '#b79cff', desc: 'Slow and very tough.' },
  { name: 'Titan',     radius: 15,  speed: 24,  hp: 3600, reward: 40,   leak: 10, armor: 0,  color: '#e6edf3', desc: 'Boss. Arrives every tenth wave.' },
  { name: 'Sprinter',  radius: 4,   speed: 128, hp: 12,   reward: 0.6,  leak: 1,  armor: 0,  color: '#fde047', desc: 'Very fast. Gets through before slow towers react.' },
  { name: 'Plated',    radius: 7.5, speed: 46,  hp: 130,  reward: 2.5,  leak: 2,  armor: 10, color: '#94a3b8', desc: 'Armored: every bullet loses 10 damage. Beams and fire ignore armor.' },
  { name: 'Medic',     radius: 6,   speed: 52,  hp: 90,   reward: 3,    leak: 2,  armor: 0,  color: '#4ade80', desc: 'Heals enemies around it. Kill it first.' },
  { name: 'Phantom',   radius: 5.5, speed: 70,  hp: 55,   reward: 2,    leak: 1,  armor: 0,  color: '#f0abfc', desc: 'Flickers out of reach for a moment every few seconds.' },
  { name: 'Shielded',  radius: 6.5, speed: 50,  hp: 80,   reward: 3.5,  leak: 2,  armor: 0,  color: '#22d3ee', desc: 'Regenerating shield. Burning damage ignores it.' },
  { name: 'Berserker', radius: 7,   speed: 44,  hp: 150,  reward: 3.5,  leak: 3,  armor: 0,  color: '#dc2626', desc: 'Gets much faster the more it is hurt.' },
];
export const ENEMY_KINDS = ENEMIES.length - 1;

// kind index matches the GPU: 0 gun, 1 laser, 2 flame, 3 mortar
// Base stats at tier 0. Upgrade nodes below modify these. Meaning of the fields:
//   dmg: per shot (gun, mortar) or per second (laser, flame); rate: shots per second
//   radius: beam half width (laser), cone cosine (flame), blast radius (mortar)
//   splash/pierce/pct/slow/ignite/spread/ramp: special effects, all 0 unless an upgrade sets them
const FX = { splash: 0, pierce: 0, pct: 0, slow: 0, ignite: 0, spread: 0, ramp: 0, flight: 0.8 };
export const TOWERS = [
  { id: 'gun', name: 'Gun', color: '#5eead4', blurb: 'Fast single target', cost: 60,
    base: { ...FX, range: 175, dmg: 14, rate: 3.2, radius: 0 } },
  { id: 'laser', name: 'Laser', color: '#60a5fa', blurb: 'Beam pierces a line', cost: 150,
    base: { ...FX, range: 210, dmg: 26, rate: 1, radius: 5 } },
  { id: 'flame', name: 'Flame', color: '#ff7a45', blurb: 'Burns a cone', cost: 110,
    base: { ...FX, range: 100, dmg: 22, rate: 1, radius: 0.86, ignite: 11 } },
  { id: 'mortar', name: 'Mortar', color: '#fbbf24', blurb: 'Explodes crowds', cost: 130,
    base: { ...FX, range: 260, dmg: 55, rate: 0.7, radius: 56 } },
];

// Upgrade trees. Tier 1 offers two paths, tier 2 offers two options inside the chosen path,
// tier 3 is a shared capstone. Choosing a node locks out its siblings for good.
// mods.mul multiplies a stat, mods.set replaces it.
const node = (id, tier, parent, name, desc, mul = {}, set = {}) => ({ id, tier, parent, name, desc, mods: { mul, set } });
export const TREES = [
  [ // gun
    node('rapid', 1, null, 'Rapid Fire', 'Fires 60% faster, lighter rounds', { rate: 1.6, dmg: 0.9 }),
    node('heavy', 1, null, 'Long Barrel', 'Longer reach, much harder hits, slower', { range: 1.3, dmg: 1.9, rate: 0.6 }),
    node('gatling', 2, 'rapid', 'Gatling', 'Fire rate x1.8', { rate: 1.8 }),
    node('frag', 2, 'rapid', 'Frag Rounds', 'Hits splash nearby enemies for half damage', {}, { splash: 30 }),
    node('pierce', 2, 'heavy', 'Piercing Rounds', 'Shots punch through everything on the line', { dmg: 0.8 }, { pierce: 3.5 }),
    node('breaker', 2, 'heavy', 'Armor Breaker', 'Each hit also deals 8% of max health', {}, { pct: 0.08 }),
  ],
  [ // laser
    node('wide', 1, null, 'Wide Lens', 'Beam is 2.4x wider', { radius: 2.4, dmg: 0.9 }),
    node('focus', 1, null, 'Focus Lens', 'More reach and 50% more damage', { range: 1.35, dmg: 1.5, radius: 0.8 }),
    node('overcharge', 2, 'wide', 'Overcharge', 'Damage ramps up to x3 while locked on', {}, { ramp: 2 }),
    node('cryo', 2, 'wide', 'Cryo Beam', 'Slows everything it touches by 45%', {}, { slow: 0.45 }),
    node('sear', 2, 'focus', 'Searing Beam', 'Sets enemies on fire', {}, { ignite: 14 }),
    node('deadeye', 2, 'focus', 'Deadeye', 'Melts 1.6% of max health per second', {}, { pct: 0.016 }),
  ],
  [ // flame
    node('napalm', 1, null, 'Napalm', 'Burning does 2.2x damage', { ignite: 2.2 }),
    node('dragon', 1, null, 'Dragon Breath', 'Longer, narrower, hotter flame', { range: 1.5, dmg: 1.3 }, { radius: 0.93 }),
    node('wildfire', 2, 'napalm', 'Wildfire', 'Burning enemies ignite their neighbours', {}, { spread: 1 }),
    node('brim', 2, 'napalm', 'Brimstone', 'Tar slows enemies by 35%, flame hits 30% harder', { dmg: 1.3 }, { slow: 0.35 }),
    node('blue', 2, 'dragon', 'Blue Flame', 'Flame damage x1.8', { dmg: 1.8 }),
    node('storm', 2, 'dragon', 'Firestorm', 'Wide 90 degree cone', { range: 0.85 }, { radius: 0.62 }),
  ],
  [ // mortar
    node('heavyshell', 1, null, 'Heavy Shells', 'Bigger blast and 70% more damage, slower', { dmg: 1.7, radius: 1.25, rate: 0.75 }),
    node('rapidmortar', 1, null, 'Rapid Mortar', 'Fires 90% faster with a shorter flight', { rate: 1.9, dmg: 0.65 }, { flight: 0.55 }),
    node('siege', 2, 'heavyshell', 'Siege Breaker', 'Deals 7% of max health on top, +20% damage', { dmg: 1.2 }, { pct: 0.07 }),
    node('shock', 2, 'heavyshell', 'Shock Shells', 'Blast slows enemies by 55% and is 20% wider', { radius: 1.2 }, { slow: 0.55 }),
    node('incend', 2, 'rapidmortar', 'Incendiary', 'Blast sets enemies on fire', {}, { ignite: 16 }),
    node('saturate', 2, 'rapidmortar', 'Saturation', 'Blast radius x1.5, fires 20% faster', { radius: 1.5, rate: 1.2 }),
  ],
];
const MASTER = node('master', 3, null, 'Veteran', 'Damage +50%, range +10%, fire rate +10%', { dmg: 1.5, range: 1.1, rate: 1.1 });
const TIER_COST = [0.8, 1.4, 2.4];

export const NODES = TREES.map((tree) => Object.fromEntries([...tree, MASTER].map((n) => [n.id, n])));
export const MAX_TIER = 3;
export const nodeCost = (kind, n) => Math.round((TOWERS[kind].cost * TIER_COST[n.tier - 1]) / 5) * 5;

// Nodes the tower may buy next. Siblings of a taken node are gone for good (mutually exclusive).
export function choices(kind, path) {
  if (path.length === 0) return TREES[kind].filter((n) => n.tier === 1);
  if (path.length === 1) return TREES[kind].filter((n) => n.parent === path[0]);
  if (path.length === 2) return [MASTER];
  return [];
}

// base: optional custom-design base stats; bonus: global research multipliers {dmg, range}
export function towerStats(kind, path, base = TOWERS[kind].base, bonus = null) {
  const s = { ...base };
  for (const id of path) {
    const { mul, set } = NODES[kind][id].mods;
    for (const k in mul) s[k] *= mul[k];
    Object.assign(s, set);
  }
  if (bonus) { s.dmg *= 1 + (bonus.dmg || 0); s.range *= 1 + (bonus.range || 0); }
  return s;
}

export function statLine(kind, s) {
  const n = (v) => Math.round(v);
  if (kind === 0) return `${n(s.dmg)} dmg  ${s.rate.toFixed(1)}/s`;
  if (kind === 1) return `${n(s.dmg)} dps  beam ${(s.radius * 2).toFixed(0)}px`;
  if (kind === 2) return `${n(s.dmg)} dps  burn ${n(s.ignite)}/s`;
  return `${n(s.dmg)} blast  r${n(s.radius)}  ${s.rate.toFixed(2)}/s`;
}

export const MAX_LEVEL = MAX_TIER;
export const SELL_RATIO = 0.7;
export const TOWER_SPACING = 36;
export const BUILD_DEPTH = 15; // min distance from a rock edge to place a tower

export const START_GOLD = 170;
export const START_LIVES = 25;
export const FIRST_WAVE_DELAY = 18;
export const WAVE_BONUS = (n) => 5 + n; // flat gold when a wave launches
export const WAVE_GAP = 26;

// Wave n (1-based) -> counts per enemy kind + spawn duration + scaling.
// Share of a wave per enemy kind: [first wave it appears, base share, share per wave after, max share]
const SHARES = {
  2: [2, 0.10, 0.03, 0.38], 5: [3, 0.04, 0.008, 0.14], 3: [5, 0.02, 0.02, 0.16], 6: [6, 0.02, 0.012, 0.12],
  7: [8, 0.01, 0.006, 0.05], 8: [11, 0.01, 0.01, 0.08], 9: [13, 0.02, 0.011, 0.1], 10: [16, 0.02, 0.008, 0.08],
};

// Wave n (1-based) -> counts per enemy kind (index = kind), spawn duration and scaling.
export function waveSpec(n) {
  const total = Math.floor(14 + 10 * Math.pow(n, 1.25));
  const counts = new Array(ENEMIES.length).fill(0);
  let others = 0;
  for (const [k, [from, base, per, max]] of Object.entries(SHARES)) {
    if (n < from) continue;
    const c = Math.max(2, Math.floor(total * Math.min(max, base + per * (n - from))));
    counts[k] = c; others += c;
  }
  counts[1] = Math.max(total - others, 10);
  counts[4] = n % 10 === 0 ? n / 10 : 0;
  return { counts, duration: 14 + Math.min(16, n * 0.6), hpScale: Math.pow(1.08, n - 1), goldMult: 1 + 0.025 * (n - 1) };
}

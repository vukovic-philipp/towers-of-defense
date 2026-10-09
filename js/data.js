// Shared game data. Numbers here are mirrored into the GPU shaders at build time.
export const WORLD_W = 1600;
export const WORLD_H = 900;

export const MAX_ENEMIES = 4096;
export const MAX_TOWERS = 64;
export const MORTAR_FLIGHT = 0.8;

// Enemy kinds are 1..4 on the GPU (0 means "slot is free").
export const ENEMIES = [
  null,
  { name: 'Swarmer', radius: 4.5, speed: 72, hp: 14,   reward: 1,  leak: 1,  color: '#f4b266' },
  { name: 'Grunt',   radius: 6,   speed: 56, hp: 42,   reward: 2,  leak: 1,  color: '#f07178' },
  { name: 'Brute',   radius: 9.5, speed: 36, hp: 260,  reward: 8,  leak: 3,  color: '#b79cff' },
  { name: 'Titan',   radius: 15,  speed: 24, hp: 3600, reward: 80, leak: 10, color: '#e6edf3' },
];

// kind index matches the GPU: 0 gun, 1 laser, 2 flame, 3 mortar
export const TOWERS = [
  {
    id: 'gun', name: 'Gun', color: '#5eead4', blurb: 'Fast single target',
    cost: 60, upgrade: [45, 90, 170], minRange: 0,
    range: [175, 190, 205, 225], dmg: [14, 22, 34, 54], rate: [3.2, 3.6, 4.2, 5], radius: [0, 0, 0, 0],
    stat: (l) => `${T0.dmg[l]} dmg  ${T0.rate[l]}/s`,
  },
  {
    id: 'laser', name: 'Laser', color: '#60a5fa', blurb: 'Beam pierces a line',
    cost: 150, upgrade: [110, 200, 360], minRange: 0,
    range: [210, 225, 245, 270], dmg: [26, 46, 78, 130], rate: [1, 1, 1, 1], radius: [5, 5.5, 6, 7],
    stat: (l) => `${T1.dmg[l]} dps  pierce`,
  },
  {
    id: 'flame', name: 'Flame', color: '#ff7a45', blurb: 'Burns a cone',
    cost: 110, upgrade: [80, 150, 280], minRange: 0,
    range: [100, 110, 122, 138], dmg: [22, 38, 62, 100], rate: [1, 1, 1, 1], radius: [0, 0, 0, 0],
    stat: (l) => `${T2.dmg[l]} dps  + burn`,
  },
  {
    id: 'mortar', name: 'Mortar', color: '#fbbf24', blurb: 'Explodes crowds',
    cost: 130, upgrade: [95, 170, 320], minRange: 70,
    range: [260, 280, 300, 330], dmg: [42, 72, 118, 195], rate: [0.55, 0.6, 0.7, 0.8], radius: [52, 58, 65, 74],
    stat: (l) => `${T3.dmg[l]} blast  r${T3.radius[l]}`,
  },
];
const [T0, T1, T2, T3] = TOWERS;
export const MAX_LEVEL = 3;
export const FLAME_COS = 0.86;
export const SELL_RATIO = 0.7;
export const TOWER_SPACING = 36;
export const BUILD_DEPTH = 15; // min distance from a rock edge to place a tower

export const START_GOLD = 200;
export const START_LIVES = 25;
export const FIRST_WAVE_DELAY = 14;
export const WAVE_GAP = 26;

export function towerValue(t) {
  let v = TOWERS[t.kind].cost;
  for (let i = 0; i < t.level; i++) v += TOWERS[t.kind].upgrade[i];
  return v;
}

// Wave n (1-based) -> counts per enemy kind + spawn duration + scaling.
export function waveSpec(n) {
  const total = Math.floor(14 + 10 * Math.pow(n, 1.25));
  const titans = n % 10 === 0 ? n / 10 : 0;
  const brutes = n >= 5 ? Math.floor(total * Math.min(0.3, (n - 4) * 0.025)) : 0;
  const grunts = n >= 2 ? Math.floor(total * Math.min(0.5, 0.12 + n * 0.035)) : 0;
  const swarmers = Math.max(total - brutes - grunts, 10);
  return {
    counts: [0, swarmers, grunts, brutes, titans],
    duration: 14 + Math.min(16, n * 0.6),
    hpScale: Math.pow(1.08, n - 1),
    goldMult: 1 + 0.07 * (n - 1),
  };
}

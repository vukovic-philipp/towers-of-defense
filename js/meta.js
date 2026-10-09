// Persistent progress between runs: research points, research levels and saved turret designs.
// Pure logic with an injectable storage so it can be tested in Node.
const KEY = 'towers-of-defense-meta-v2';

export const BRANCHES = ['Economy', 'Defense', 'Engineering', 'Arsenal', 'Mastery', 'Logistics'];

// cost[i] is the price of level i+1. req: [id, level] must be reached first.
export const RESEARCH = [
  { id: 'eco_start', branch: 0, name: 'War Chest', desc: 'Start each run with +30 gold', max: 4, cost: [6, 10, 16, 24] },
  { id: 'eco_bounty', branch: 0, name: 'Bounty Hunters', desc: 'Kills pay 8% more gold', max: 4, cost: [8, 14, 22, 32], req: ['eco_start', 1] },
  { id: 'eco_wave', branch: 0, name: 'Supply Line', desc: 'Each wave brings +3 gold', max: 3, cost: [10, 18, 30], req: ['eco_bounty', 1] },
  { id: 'eco_sell', branch: 0, name: 'Salvage', desc: 'Selling returns 6% more', max: 3, cost: [8, 14, 24], req: ['eco_start', 2] },

  { id: 'def_lives', branch: 1, name: 'Fortified Gate', desc: 'Start with +3 lives', max: 4, cost: [6, 10, 16, 24] },
  { id: 'def_dmg', branch: 1, name: 'Hardened Ammo', desc: 'All towers deal 5% more damage', max: 5, cost: [10, 16, 24, 34, 48], req: ['def_lives', 1] },
  { id: 'def_range', branch: 1, name: 'Spotters', desc: 'All towers reach 3% further', max: 4, cost: [10, 16, 24, 34], req: ['def_dmg', 1] },
  { id: 'def_slow', branch: 1, name: 'Mud and Snow', desc: 'Enemies move 3% slower', max: 4, cost: [12, 20, 30, 44], req: ['def_dmg', 2] },

  { id: 'eng_discount', branch: 2, name: 'Bulk Orders', desc: 'Towers cost 4% less', max: 4, cost: [8, 14, 22, 32] },
  { id: 'eng_upgrade', branch: 2, name: 'Field Kits', desc: 'Upgrades cost 6% less', max: 4, cost: [8, 14, 22, 32], req: ['eng_discount', 1] },
  { id: 'eng_budget', branch: 2, name: 'Prototype Lab', desc: 'Workshop point budget +2', max: 3, cost: [10, 18, 30] },
  { id: 'eng_slots', branch: 2, name: 'Drafting Tables', desc: 'One more saved turret design', max: 3, cost: [8, 14, 22], req: ['eng_budget', 1] },
  { id: 'eng_perks', branch: 2, name: 'Modular Frames', desc: 'Designs may carry a third perk', max: 1, cost: [30], req: ['eng_budget', 2] },

  { id: 'perk_pierce', branch: 3, name: 'Perk: Piercing', desc: 'Workshop: shots punch through lines', max: 1, cost: [18], req: ['eng_budget', 1] },
  { id: 'perk_break', branch: 3, name: 'Perk: Armor Breaker', desc: 'Workshop: hits deal % of max health', max: 1, cost: [22], req: ['perk_pierce', 1] },
  { id: 'perk_spread', branch: 3, name: 'Perk: Wildfire', desc: 'Workshop: fire jumps between enemies', max: 1, cost: [24], req: ['def_dmg', 2] },
  { id: 'perk_ramp', branch: 3, name: 'Perk: Overcharge', desc: 'Workshop: beam damage ramps up', max: 1, cost: [28], req: ['perk_spread', 1] },

  // tier 4 upgrades (masteries) and tier 5 upgrades (ultimates), one pair per weapon
  { id: 'mast_gun', branch: 4, name: 'Gun Mastery', desc: 'Unlocks tier 4 gun upgrades: Minigun, Cluster Rounds, Railgun, Executioner', max: 1, cost: [36], req: ['def_dmg', 1] },
  { id: 'ult_gun', branch: 4, name: 'Gun Ultimates', desc: 'Unlocks tier 5 gun upgrades: Overwatch and Tungsten Core', max: 1, cost: [70], req: ['mast_gun', 1] },
  { id: 'mast_laser', branch: 4, name: 'Laser Mastery', desc: 'Unlocks tier 4 laser upgrades: Meltdown, Absolute Zero, Plasma Beam, Annihilator', max: 1, cost: [40], req: ['def_dmg', 1] },
  { id: 'ult_laser', branch: 4, name: 'Laser Ultimates', desc: 'Unlocks tier 5 laser upgrades: Prism Array and Sun Lance', max: 1, cost: [75], req: ['mast_laser', 1] },
  { id: 'mast_flame', branch: 4, name: 'Flame Mastery', desc: 'Unlocks tier 4 flame upgrades: Chain Inferno, Tar Pits, White Fire, Cataclysm', max: 1, cost: [38], req: ['def_dmg', 1] },
  { id: 'ult_flame', branch: 4, name: 'Flame Ultimates', desc: 'Unlocks tier 5 flame upgrades: Dragonfire and Thermite', max: 1, cost: [72], req: ['mast_flame', 1] },
  { id: 'mast_mortar', branch: 4, name: 'Mortar Mastery', desc: 'Unlocks tier 4 mortar upgrades: Bunker Buster, Cryo Barrage, Napalm Shells, Carpet Bombing', max: 1, cost: [38], req: ['def_dmg', 1] },
  { id: 'ult_mortar', branch: 4, name: 'Mortar Ultimates', desc: 'Unlocks tier 5 mortar upgrades: Siege Engine and Barrage', max: 1, cost: [72], req: ['mast_mortar', 1] },

  // mining and ammunition
  { id: 'log_start', branch: 5, name: 'Supply Drop', desc: 'Start each run with +40 iron and +30 coal', max: 4, cost: [6, 10, 16, 24] },
  { id: 'log_drill', branch: 5, name: 'Drill Bits', desc: 'Drills mine 15% faster', max: 5, cost: [8, 12, 18, 26, 36], req: ['log_start', 1] },
  { id: 'log_stock', branch: 5, name: 'Warehouses', desc: 'Stockpile holds 100 more of each resource', max: 4, cost: [8, 14, 22, 32], req: ['log_start', 1] },
  { id: 'log_eff', branch: 5, name: 'Efficient Loading', desc: 'Towers use 8% less ammunition', max: 4, cost: [10, 16, 24, 34], req: ['log_drill', 1] },
  { id: 'log_deep', branch: 5, name: 'Deep Boring', desc: 'Drills can be upgraded to level 3', max: 1, cost: [30], req: ['log_drill', 2] },
];
const BY_ID = Object.fromEntries(RESEARCH.map((n) => [n.id, n]));
export const researchNode = (id) => BY_ID[id];

export const BASE_SLOTS = 2;
export const BASE_PERKS = 2;
export const BASE_BUDGET = 4; // spare points on top of one default point per slider

const blank = () => ({ shards: 0, lv: {}, designs: [], best: 0, map: { mode: 'sketch', seed: 0 } });

export function loadMeta(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(KEY);
    if (!raw) return blank();
    const m = { ...blank(), ...JSON.parse(raw) };
    m.lv = m.lv || {}; m.designs = Array.isArray(m.designs) ? m.designs : [];
    if (!m.map || (m.map.mode !== 'sketch' && m.map.mode !== 'random')) m.map = { mode: 'sketch', seed: 0 };
    return m;
  } catch { return blank(); }
}
export function saveMeta(meta, storage = globalThis.localStorage) {
  try { storage && storage.setItem(KEY, JSON.stringify(meta)); } catch { /* storage unavailable */ }
}

export const level = (meta, id) => meta.lv[id] || 0;
export function status(meta, id) {
  const n = BY_ID[id], l = level(meta, id);
  if (l >= n.max) return 'maxed';
  if (n.req && level(meta, n.req[0]) < n.req[1]) return 'locked';
  if (meta.shards < n.cost[l]) return 'poor';
  return 'ok';
}
export function buyResearch(meta, id) {
  if (status(meta, id) !== 'ok') return false;
  meta.shards -= BY_ID[id].cost[level(meta, id)];
  meta.lv[id] = level(meta, id) + 1;
  return true;
}

// Everything research changes, in one place.
export function effects(meta) {
  const L = (id) => level(meta, id);
  return {
    startGold: 30 * L('eco_start'), bounty: 0.08 * L('eco_bounty'), waveBonus: 3 * L('eco_wave'), sell: 0.06 * L('eco_sell'),
    lives: 3 * L('def_lives'), dmg: 0.05 * L('def_dmg'), range: 0.03 * L('def_range'), enemySlow: 0.03 * L('def_slow'),
    towerTier: ['gun', 'laser', 'flame', 'mortar'].map((w) => 3 + L('mast_' + w) + (L('mast_' + w) ? L('ult_' + w) : 0)),
    startIron: 40 * L('log_start'), startCoal: 30 * L('log_start'), drillSpeed: 1 + 0.15 * L('log_drill'),
    stockCap: 400 + 100 * L('log_stock'), ammoUse: 1 - 0.08 * L('log_eff'), drillLevels: 2 + L('log_deep'),
    towerDisc: 0.04 * L('eng_discount'), upgradeDisc: 0.06 * L('eng_upgrade'),
    budget: BASE_BUDGET + 2 * L('eng_budget'), slots: BASE_SLOTS + L('eng_slots'), perkSlots: BASE_PERKS + L('eng_perks'),
    perks: new Set(['slow', 'ignite', 'splash',
      ...(L('perk_pierce') ? ['pierce'] : []), ...(L('perk_break') ? ['pct'] : []),
      ...(L('perk_spread') ? ['spread'] : []), ...(L('perk_ramp') ? ['ramp'] : [])]),
  };
}

// Research points for a finished run.
export function shardsFor(wave, kills) {
  return Math.max(1, Math.floor(2 * wave + Math.pow(wave, 1.5) / 2 + kills / 50));
}

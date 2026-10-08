// Persistent progression: shards, tech levels, best results.
import { TECH_BY_ID, techCost } from './data.js';

const KEY = 'towers-of-defense.save.v1';

export function loadMeta() {
  const fresh = { rp: 0, levels: {}, bestWave: 0, bestKills: 0, runs: 0 };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return Object.assign(fresh, JSON.parse(raw));
  } catch (e) { /* storage unavailable */ }
  return fresh;
}
export function saveMeta(meta) {
  try { localStorage.setItem(KEY, JSON.stringify(meta)); } catch (e) { /* ignore */ }
}

export function computeMods(levels) {
  const L = id => levels[id] || 0;
  return {
    startGold: 30 * L('purse'), bounty: 1 + 0.1 * L('bounty'), interest: 0.01 * L('interest'),
    dmg: 1 + 0.08 * L('dmg'), rate: 1 + 0.06 * L('rate'), crit: 0.04 * L('crit'),
    range: 1 + 0.05 * L('range'), splash: 1 + 0.12 * L('splash'),
    lives: 2 * L('lives'), revive: L('revive') > 0,
    unlocked: { arrow: true, cannon: true, frost: L('frost') > 0, tesla: L('tesla') > 0 },
  };
}

export function techStatus(meta, id) {
  const node = TECH_BY_ID[id], lvl = meta.levels[id] || 0;
  const missing = node.req.filter(r => !(meta.levels[r] > 0)).map(r => TECH_BY_ID[r].name);
  const cost = lvl >= node.max ? null : techCost(node, lvl);
  return { node, lvl, missing, cost, maxed: lvl >= node.max, canBuy: !missing.length && cost !== null && meta.rp >= cost };
}
export function buyTech(meta, id) {
  const s = techStatus(meta, id);
  if (!s.canBuy) return false;
  meta.rp -= s.cost;
  meta.levels[id] = s.lvl + 1;
  saveMeta(meta);
  return true;
}

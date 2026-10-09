// Turret workshop maths: a design is an archetype (which behaviour it uses), points spread over
// that archetype's sliders, and up to a few perks. Everything derives from these, so the saved
// design is small and the price always matches the stats.
import { TOWERS } from './data.js';

export const DEFAULT_PTS = 2;
export const MAX_PTS = 10;
export const MIN_PTS = 0;

// slider key -> label. Which sliders each archetype has:
export const SLIDERS = [
  { dmg: 'Damage', rate: 'Fire rate', range: 'Range' },
  { dmg: 'Damage', range: 'Range', radius: 'Beam width' },
  { dmg: 'Damage', range: 'Range', radius: 'Cone width', ignite: 'Burn' },
  { dmg: 'Damage', rate: 'Fire rate', range: 'Range', radius: 'Blast radius' },
];

// perk id -> definition. cost is a fraction of the archetype's base price.
export const PERKS = {
  slow: { name: 'Slowing', desc: 'Slows enemies by 40%', cost: 0.15, set: { slow: 0.4 } },
  ignite: { name: 'Igniting', desc: 'Sets enemies on fire', cost: 0.2, set: { ignite: 14 }, only: [0, 1, 3] },
  splash: { name: 'Splash', desc: 'Nearby enemies take half damage', cost: 0.2, set: { splash: 30 }, only: [0] },
  pierce: { name: 'Piercing', desc: 'Passes through everything on its line', cost: 0.3, set: { pierce: 3.5 }, mul: { dmg: 0.8 }, only: [0] },
  pct: { name: 'Armor Breaker', desc: 'Deals extra % of max health', cost: 0.25, set: { pct: 0.05 } },
  spread: { name: 'Wildfire', desc: 'Burning enemies ignite neighbours', cost: 0.3, set: { spread: 1 }, only: [2] },
  ramp: { name: 'Overcharge', desc: 'Damage ramps up while locked on', cost: 0.25, set: { ramp: 1.5 }, only: [1] },
};
export const perksFor = (kind) => Object.keys(PERKS).filter((id) => !PERKS[id].only || PERKS[id].only.includes(kind));

const mult = (pts) => 0.4 + 0.3 * pts; // 2 points is exactly the archetype's base stat

export function defaultPts(kind) {
  return Object.fromEntries(Object.keys(SLIDERS[kind]).map((k) => [k, DEFAULT_PTS]));
}
export const maxPoints = (kind, budget) => DEFAULT_PTS * Object.keys(SLIDERS[kind]).length + budget;
export const usedPoints = (pts) => Object.values(pts).reduce((a, b) => a + b, 0);

// Normalise a (possibly stale or hand-edited) design.
export function sanitize(d, kind = d.kind) {
  const keys = Object.keys(SLIDERS[kind]);
  const pts = {};
  for (const k of keys) {
    const v = d.pts ? Number(d.pts[k]) : NaN;
    pts[k] = Math.min(MAX_PTS, Math.max(MIN_PTS, Number.isFinite(v) ? Math.round(v) : DEFAULT_PTS));
  }
  const perks = (d.perks || []).filter((p, i, a) => PERKS[p] && perksFor(kind).includes(p) && a.indexOf(p) === i);
  return { ...d, kind, pts, perks };
}

export function designBase(kind, pts, perks) {
  const b = { ...TOWERS[kind].base };
  const m = (k) => mult(pts[k] ?? DEFAULT_PTS);
  b.dmg *= m('dmg'); b.range *= m('range');
  if (pts.rate !== undefined) b.rate *= m('rate');
  if (kind === 1 || kind === 3) b.radius *= m('radius');
  if (kind === 2) {
    b.radius = Math.max(0.3, Math.cos(Math.acos(b.radius) * m('radius')));
    b.ignite *= m('ignite');
  }
  for (const id of perks) {
    const p = PERKS[id];
    if (p.mul) for (const k in p.mul) b[k] *= p.mul[k];
    Object.assign(b, p.set);
  }
  return b;
}

// Price before research discounts. Smooth in the stats, with default sliders costing the base price.
export function designCost(kind, pts, perks) {
  const m = (k) => (pts[k] === undefined ? 1 : mult(pts[k]));
  const power = Math.pow(m('dmg') * m('rate'), 0.85) * Math.pow(m('range'), 0.4)
    * Math.pow(m('radius'), 0.4) * Math.pow(m('ignite'), 0.25);
  const base = TOWERS[kind].cost;
  const perkCost = perks.reduce((a, id) => a + PERKS[id].cost, 0);
  return Math.max(20, Math.round((base * (0.3 + 0.7 * power + perkCost)) / 5) * 5);
}

// Research discounts: percentage off, rounded to the 5 gold the shop works in.
export const discount = (cost, frac) => Math.max(5, Math.round((cost * (1 - frac)) / 5) * 5);

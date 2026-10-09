// Mining and ammunition. Drills sit on ore patches beside the canyon and fill a shared stockpile; every
// tower burns ammunition from that stockpile while it fires and goes dark when its resource runs out.
// Pure logic, no DOM or GPU, so it can be tested in Node.
export const RESOURCES = {
  iron: { name: 'Iron', color: '#9cc3ee', use: 'Ammunition for guns and mortars' },
  coal: { name: 'Coal', color: '#f0a35e', use: 'Fuel for flamethrowers and power for lasers' },
};
export const RES_IDS = Object.keys(RESOURCES);

// What each weapon burns, indexed by tower kind: units per shot (gun, mortar) or per second of firing (laser, flame).
export const AMMO = [
  { res: 'iron', per: 0.12, unit: 'shot' },
  { res: 'coal', per: 0.35, unit: 'second' },
  { res: 'coal', per: 0.5, unit: 'second' },
  { res: 'iron', per: 1.1, unit: 'shell' },
];

export const START_STOCK = { iron: 90, coal: 60 };
export const STOCK_CAP = 400;

export const DRILL = {
  cost: 45,
  upgrade: [0, 70, 130],       // gold to reach level 1, 2, 3
  mult: [1, 1.7, 2.6],         // output per level
  rate: 0.9,                   // units per second on a patch of richness 1
  spacing: 26,                 // minimum distance between drills
  perPatch: 4,
  sell: 0.6,
};

export const drillRate = (patch, level, fx) => DRILL.rate * patch.rich * DRILL.mult[level - 1] * (fx ? fx.drillSpeed : 1);
export const drillInvested = (level) => DRILL.cost + DRILL.upgrade.slice(1, level).reduce((a, b) => a + b, 0);

export function newStock(fx) {
  return { iron: START_STOCK.iron + fx.startIron, coal: START_STOCK.coal + fx.startCoal };
}

// Which patch (if any) a world point lies on, and whether a drill fits there.
export function patchAt(patches, x, y) {
  let best = -1, bd = Infinity;
  patches.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < p.r && d < bd) { bd = d; best = i; } });
  return best;
}
export function canDrill(patches, drills, x, y) {
  const i = patchAt(patches, x, y);
  if (i < 0) return { ok: false, why: 'Drills go on ore' };
  const p = patches[i];
  if (Math.hypot(p.x - x, p.y - y) > p.r - 8) return { ok: false, why: 'Too close to the patch edge' };
  const here = drills.filter((d) => d && d.patch === i);
  if (here.length >= DRILL.perPatch) return { ok: false, why: 'This patch is full' };
  if (here.some((d) => Math.hypot(d.x - x, d.y - y) < DRILL.spacing)) return { ok: false, why: 'Too close to another drill' };
  return { ok: true, patch: i };
}
export const drillAt = (drills, x, y) => {
  let best = -1, bd = 20;
  drills.forEach((d, i) => { if (d) { const k = Math.hypot(d.x - x, d.y - y); if (k < bd) { bd = k; best = i; } } });
  return best;
};

// Income per second of every resource from the given drills.
export function income(patches, drills, fx) {
  const out = { iron: 0, coal: 0 };
  for (const d of drills) if (d) out[patches[d.patch].res] += drillRate(patches[d.patch], d.level, fx);
  return out;
}

// Advance the stockpile by dt seconds of mining. Returns what was actually banked.
export function mine(stock, patches, drills, fx, dt) {
  const inc = income(patches, drills, fx);
  for (const r of RES_IDS) stock[r] = Math.min(fx.stockCap, stock[r] + inc[r] * dt);
  return inc;
}

// Bill towers for what they fired since the last reading. usage[slot] is the GPU's running total of shots
// (or seconds) for that slot; prev is our copy of it. A reading below the previous one means the slot was
// reused by a new tower, so the whole reading counts. Empty slots just track the reading. Returns units spent per resource.
export function billAmmo(stock, towers, usage, prev, fx) {
  const spent = { iron: 0, coal: 0 };
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i], u = usage[i];
    if (!t) { prev[i] = u; continue; } // keep following empty slots so a stale reading cannot be billed to a newcomer
    let delta = u - prev[i];
    if (delta < 0) delta = u;
    prev[i] = u;
    if (delta <= 0) continue;
    const a = AMMO[t.kind];
    spent[a.res] += delta * a.per * fx.ammoUse;
  }
  for (const r of RES_IDS) stock[r] = Math.max(0, stock[r] - spent[r]);
  return spent;
}

// Hysteresis so a drill trickling in one unit does not make towers flicker every frame.
export function updateStarved(starved, stock) {
  let changed = false;
  for (const r of RES_IDS) {
    const next = starved[r] ? stock[r] < 1.5 : stock[r] <= 0.001;
    if (next !== starved[r]) { starved[r] = next; changed = true; }
  }
  return changed;
}

export const isStarved = (starved, kind) => !!starved[AMMO[kind].res];
export const ammoText = (kind, fx) => {
  const a = AMMO[kind], per = a.per * (fx ? fx.ammoUse : 1);
  return `${per.toFixed(2)} ${RESOURCES[a.res].name.toLowerCase()} per ${a.unit}`;
};

import {
  WORLD_W, WORLD_H, MAX_ENEMIES, MAX_TOWERS, TOWERS, TREES, NODES, SELL_RATIO, TOWER_SPACING,
  START_GOLD, START_LIVES, FIRST_WAVE_DELAY, WAVE_GAP, WAVE_BONUS, ENEMIES, waveSpec,
  choices, nodeCost, towerStats, statLine,
} from './data.js';
import { makeBuildCheck } from './map.js';
import { generateMap, sketchMap, mulberry32 } from './mapgen.js';
import { createGpu } from './gpu.js';
import { loadMeta, saveMeta, effects, shardsFor, researchNode } from './meta.js';
import {
  RESOURCES, RES_IDS, AMMO, DRILL, newStock, patchAt, canDrill, drillAt, drillRate, drillInvested, income, mine, billAmmo,
  updateStarved, isStarved, ammoText,
} from './economy.js';
import { sanitize, designBase, designCost, discount } from './design.js';
import { initResearch } from './research.js';
import { initWorkshop } from './workshop.js';

const $ = (id) => document.getElementById(id);
const el = {
  gold: $('hGold'), iron: $('hIron'), coal: $('hCoal'), ironR: $('hIronR'), coalR: $('hCoalR'), lives: $('hLives'), wave: $('hWave'), alive: $('hAlive'), next: $('hNext'),
  bShop: $('bShop'), bPause: $('bPause'), bSpeed: $('bSpeed'),
  board: $('board'), stage: $('stage'), cT: $('cTerrain'), cG: $('cGpu'), cU: $('cUi'),
  panel: $('panel'), toast: $('toast'),
  menu: $('menu'), mPlay: $('mPlay'), mError: $('mError'), mResearch: $('mResearch'), mShop: $('mShop'), mShards: $('mShards'), mBest: $('mBest'),
  mMapSketch: $('mMapSketch'), mMapRandom: $('mMapRandom'), mReroll: $('mReroll'), mSeed: $('mSeed'), mPreview: $('mPreview'),
  tree: $('tree'), treeBody: $('treeBody'), treeTitle: $('treeTitle'), treeGold: $('treeGold'), treeClose: $('treeClose'),
  over: $('over'), oWave: $('oWave'), oKills: $('oKills'), oBest: $('oBest'), oRetry: $('oRetry'), oMenu: $('oMenu'), oShards: $('oShards'), oResearch: $('oResearch'), oShop: $('oShop'),
};

const meta = loadMeta();
const sketch = sketchMap();
let world = sketch;                 // {layout: {walls, rocks, ore}, map, seed}
let map = world.map;
let build = makeBuildCheck(map);
let gpu = null;
let FX = effects(meta); // research bonuses for the current run

const G = {
  running: false, paused: false, over: false, speed: 1,
  gold: 0, lives: 0, wave: 0, kills: 0,
  towers: new Array(MAX_TOWERS).fill(null), // slot -> {kind, path, x, y, base, color, name, invested}
  towerCount: 0,                            // high-water mark for the GPU loop
  selected: -1,                             // tower slot
  spot: null,                               // {x, y} pending build location
  hover: null,
  nextIn: 0, queue: [], plan: null,
  ring: 0, spawned: 0, frame: 0, time: 0,
  seen: { kills: 0, gold: 0, leaks: 0 },
  seenKinds: new Set(),
  stock: { iron: 0, coal: 0 }, starved: { iron: false, coal: false }, drills: [], selectedDrill: -1,
  usagePrev: new Float32Array(MAX_TOWERS), flow: { iron: 0, coal: 0, spendIron: 0, spendCoal: 0 }, warned: { iron: false, coal: false },
};

// ---------- layout ----------
let scale = 1, dpr = 1;
function resize() {
  const r = el.stage.getBoundingClientRect();
  const w = Math.min(r.width, (r.height * 16) / 9), h = (w * 9) / 16;
  el.board.style.width = `${Math.floor(w)}px`;
  el.board.style.height = `${Math.floor(h)}px`;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  for (const c of [el.cT, el.cG, el.cU]) { c.width = pw; c.height = ph; }
  scale = pw / WORLD_W;
  drawTerrain();
}
new ResizeObserver(resize).observe(el.stage);

// ---------- terrain (static 2D layer under the GPU canvas) ----------
function poly(ctx, p) { ctx.beginPath(); p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
// full: the playfield with build dots and labels; otherwise a plain map preview
function paintWorld(ctx, full) {
  ctx.fillStyle = '#0d1218';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  if (full) {
    // faint ruled lines, a nod to the paper sketch
    ctx.strokeStyle = 'rgba(139,152,165,0.045)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 40; x < WORLD_W; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); }
    ctx.stroke();
  }
  // entry and gate glow
  let g = ctx.createLinearGradient(0, 0, 90, 0); g.addColorStop(0, 'rgba(94,234,212,0.10)'); g.addColorStop(1, 'rgba(94,234,212,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 90, WORLD_H);
  g = ctx.createLinearGradient(WORLD_W, 0, WORLD_W - 110, 0); g.addColorStop(0, 'rgba(240,113,120,0.22)'); g.addColorStop(1, 'rgba(240,113,120,0)');
  ctx.fillStyle = g; ctx.fillRect(WORLD_W - 110, 0, 110, WORLD_H);

  for (const w of world.layout.walls) {
    poly(ctx, w); ctx.fillStyle = '#06080b'; ctx.fill();
    ctx.strokeStyle = '#222c38'; ctx.lineWidth = full ? 2 : 5; ctx.stroke();
  }
  for (const r of world.layout.rocks) {
    poly(ctx, r); ctx.fillStyle = '#18202a'; ctx.fill();
    ctx.save(); ctx.clip(); ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 22; poly(ctx, r); ctx.stroke(); ctx.restore();
    poly(ctx, r); ctx.strokeStyle = '#34414f'; ctx.lineWidth = full ? 2 : 5; ctx.stroke();
  }
  // ore patches on the high ground
  (world.layout.ore || []).forEach((p, i) => {
    const col = RESOURCES[p.res].color, rnd = mulberry32(i * 7919 + Math.round(p.x));
    ctx.globalAlpha = 0.13; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 0.55; ctx.strokeStyle = col; ctx.lineWidth = full ? 1.5 : 4; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 0.8;
    for (let k = 0; k < 18; k++) {
      const a = rnd() * 6.2832, d = Math.sqrt(rnd()) * (p.r - 5), sz = 2 + rnd() * 2.6;
      ctx.fillRect(p.x + Math.cos(a) * d - sz / 2, p.y + Math.sin(a) * d - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
    if (full) {
      ctx.font = '600 11px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = col; ctx.globalAlpha = 0.85;
      ctx.fillText(`${RESOURCES[p.res].name.toUpperCase()} x${p.rich.toFixed(2)}`, p.x, p.y + p.r + 12);
      ctx.globalAlpha = 1;
    }
  });
  if (!full) return;
  // dots show where a tower fits
  ctx.fillStyle = 'rgba(94,234,212,0.22)';
  for (let y = 10; y < WORLD_H; y += 18) {
    for (let x = 10; x < WORLD_W; x += 18) {
      if (build.canBuild(x, y)) { ctx.beginPath(); ctx.arc(x, y, 1.3, 0, 6.2832); ctx.fill(); }
    }
  }
  ctx.font = '600 13px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(94,234,212,0.7)';
  ctx.save(); ctx.translate(14, WORLD_H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('ENTRY', 0, 0); ctx.restore();
  ctx.fillStyle = 'rgba(240,113,120,0.85)';
  ctx.save(); ctx.translate(WORLD_W - 14, WORLD_H / 2); ctx.rotate(Math.PI / 2); ctx.fillText('GATE', 0, 0); ctx.restore();
}
function drawTerrain() {
  const ctx = el.cT.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  paintWorld(ctx, true);
}
function drawPreview() {
  const c = el.mPreview, ctx = c.getContext('2d');
  ctx.setTransform(c.width / WORLD_W, 0, 0, c.height / WORLD_H, 0, 0);
  paintWorld(ctx, false);
}

// ---------- UI overlay (selection, ranges) ----------
function drawUi(time) {
  const ctx = el.cU.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.cU.width, el.cU.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const ring = (x, y, r, col, dash, alpha = 1) => {
    ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.setLineDash(dash ? [6, 6] : []);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  };
  // drills: a square housing with a spinning bit, one pip per level
  G.drills.forEach((d, i) => {
    if (!d) return;
    const col = RESOURCES[world.layout.ore[d.patch].res].color;
    ctx.save(); ctx.translate(d.x, d.y);
    ctx.fillStyle = '#0d1218'; ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.fillRect(-9, -9, 18, 18); ctx.strokeRect(-9, -9, 18, 18);
    ctx.rotate(time * (1.5 + d.level * 1.2));
    ctx.fillStyle = col; ctx.fillRect(-6, -1.2, 12, 2.4); ctx.fillRect(-1.2, -6, 2.4, 12);
    ctx.rotate(-time * (1.5 + d.level * 1.2));
    for (let k = 0; k < d.level; k++) { ctx.beginPath(); ctx.arc((k - (d.level - 1) / 2) * 6, 15, 1.8, 0, 6.2832); ctx.fill(); }
    ctx.restore();
    if (i === G.selectedDrill) ring(d.x, d.y, 18, '#e6edf3', false);
  });
  if (G.selected >= 0 && G.towers[G.selected]) {
    const t = G.towers[G.selected], rg = statsOf(t).range;
    ctx.fillStyle = 'rgba(230,237,243,0.04)'; ctx.beginPath(); ctx.arc(t.x, t.y, rg, 0, 6.2832); ctx.fill();
    ring(t.x, t.y, rg, t.color, true, 0.8);
    ring(t.x, t.y, 21, '#e6edf3', false);
  }
  // towers without ammo get a warning mark
  const blink = 0.55 + 0.45 * Math.sin(time * 7);
  G.towers.forEach((t) => {
    if (!t || !isStarved(G.starved, t.kind)) return;
    ctx.globalAlpha = blink; ctx.fillStyle = RESOURCES[AMMO[t.kind].res].color;
    ctx.beginPath(); ctx.arc(t.x + 17, t.y - 17, 4.5, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#0a0d12'; ctx.fillRect(t.x + 16.2, t.y - 20, 1.7, 4.4); ctx.fillRect(t.x + 16.2, t.y - 14.8, 1.7, 1.7); ctx.globalAlpha = 1;
  });
  if (G.spot) {
    const pulse = 0.6 + 0.4 * Math.sin(time * 6);
    ring(G.spot.x, G.spot.y, 17, '#e6edf3', true, pulse);
    ctx.fillStyle = '#e6edf3'; ctx.beginPath(); ctx.arc(G.spot.x, G.spot.y, 2.5, 0, 6.2832); ctx.fill();
  }
  if (G.hover && !G.spot && G.selected < 0 && G.selectedDrill < 0) {
    const onOre = patchAt(world.layout.ore, G.hover.x, G.hover.y) >= 0;
    const ok = onOre ? canDrill(world.layout.ore, G.drills, G.hover.x, G.hover.y).ok : canPlace(G.hover.x, G.hover.y);
    ring(G.hover.x, G.hover.y, onOre ? 13 : 15, ok ? '#5eead4' : '#f07178', false, 0.55);
  }
}

// ---------- building ----------
function canPlace(x, y) {
  if (!build.canBuild(x, y)) return false;
  for (const t of G.towers) if (t && Math.hypot(t.x - x, t.y - y) < TOWER_SPACING) return false;
  return true;
}
function towerAt(x, y) {
  let best = -1, bd = 28;
  G.towers.forEach((t, i) => { if (t) { const d = Math.hypot(t.x - x, t.y - y); if (d < bd) { bd = d; best = i; } } });
  return best;
}
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255); };
const statsOf = (t) => towerStats(t.kind, t.path, t.base, FX);
const upgradeCost = (kind, n) => discount(nodeCost(kind, n), FX.upgradeDisc);
const sellValue = (t) => Math.floor(t.invested * (SELL_RATIO + FX.sell));

// Everything the player can build right now: the four standard towers plus saved workshop designs.
function buildOptions() {
  const opts = TOWERS.map((d, kind) => ({ kind, name: d.name, color: d.color, blurb: d.blurb, base: d.base, cost: discount(d.cost, FX.towerDisc) }));
  for (const raw of meta.designs.slice(0, FX.slots)) {
    const d = sanitize(raw);
    opts.push({ kind: d.kind, name: d.name, color: d.color, blurb: `Custom ${TOWERS[d.kind].name}`, base: designBase(d.kind, d.pts, d.perks),
      cost: discount(designCost(d.kind, d.pts, d.perks), FX.towerDisc) });
  }
  return opts;
}
function syncTowers(resetSlot) {
  G.towerCount = 0;
  G.towers.forEach((t, i) => { if (t) G.towerCount = i + 1; });
  gpu.uploadTowers(G.towers.map((t) => t && { x: t.x, y: t.y, kind: t.kind, tier: t.path.length, stats: statsOf(t), color: hexRgb(t.color), starved: isStarved(G.starved, t.kind) }),
    resetSlot === undefined ? [] : [resetSlot]);
}
function placeTower(opt) {
  if (!G.spot || G.gold < opt.cost) return;
  const slot = G.towers.findIndex((t) => !t);
  if (slot < 0) return toast('Tower limit reached');
  G.gold -= opt.cost;
  G.towers[slot] = { kind: opt.kind, path: [], x: G.spot.x, y: G.spot.y, base: opt.base, color: opt.color, name: opt.name, invested: opt.cost };
  G.spot = null; G.selected = slot; G.selectedDrill = -1;
  syncTowers(slot); renderPanel(); updateHud();
}
function buyNode(id) {
  const t = G.towers[G.selected]; if (!t) return;
  const n = choices(t.kind, t.path, FX.towerTier[t.kind]).find((c) => c.id === id);
  if (!n) return;
  const cost = upgradeCost(t.kind, n);
  if (G.gold < cost) return toast('Not enough gold');
  G.gold -= cost; t.invested += cost; t.path.push(id);
  syncTowers(); renderPanel(); renderTree(); updateHud();
}
function sellTower() {
  closeTree();
  const t = G.towers[G.selected]; if (!t) return;
  G.gold += sellValue(t);
  const slot = G.selected;
  G.towers[slot] = null; G.selected = -1;
  syncTowers(slot); renderPanel(); updateHud();
}
// ---------- drills ----------
const drillOut = (d) => drillRate(world.layout.ore[d.patch], d.level, FX);
function placeDrill() {
  const sp = G.spot;
  if (!sp || sp.patch === undefined) return;
  const cost = discount(DRILL.cost, FX.towerDisc);
  if (G.gold < cost) return toast('Not enough gold');
  G.gold -= cost;
  const d = { patch: sp.patch, x: sp.x, y: sp.y, level: 1, invested: cost };
  const slot = G.drills.findIndex((x) => !x);
  if (slot < 0) G.drills.push(d); else G.drills[slot] = d;
  G.selectedDrill = slot < 0 ? G.drills.length - 1 : slot; G.spot = null;
  renderPanel(); updateHud();
}
const drillUpgradeCost = (d) => discount(DRILL.upgrade[d.level], FX.upgradeDisc);
function upgradeDrill() {
  const d = G.drills[G.selectedDrill];
  if (!d || d.level >= FX.drillLevels) return;
  const c = drillUpgradeCost(d);
  if (G.gold < c) return toast('Not enough gold');
  G.gold -= c; d.invested += c; d.level++;
  renderPanel(); updateHud();
}
const drillSellValue = (d) => Math.floor(d.invested * (DRILL.sell + FX.sell));
function sellDrill() {
  const d = G.drills[G.selectedDrill];
  if (!d) return;
  G.gold += drillSellValue(d); G.drills[G.selectedDrill] = null; G.selectedDrill = -1;
  renderPanel(); updateHud();
}

function refreshPanel() {
  for (const b of el.panel.children) if (b.dataset.cost !== undefined) b.classList.toggle('dim', G.gold < +b.dataset.cost);
}
function clearSelection() { G.spot = null; G.selected = -1; G.selectedDrill = -1; closeTree(); renderPanel(); }

let toastTimer = 0;
function toast(msg, ms = 1400) {
  el.toast.textContent = msg; el.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

const DOT = ['', 'dia', '', 'sq'];
const WEAPON_KEYS = ['gun', 'laser', 'flame', 'mortar'];
function escapeHtml(x) { return String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// research that opens a tier for a weapon
const tierResearch = (kind, tier) => researchNode((tier >= 5 ? 'ult_' : 'mast_') + WEAPON_KEYS[kind]).name;
function renderPanel() {
  el.panel.innerHTML = '';
  const mkBtn = (cls, html, fn, cost = 0) => {
    const b = document.createElement('button'); b.className = cls + (G.gold < cost ? ' dim' : ''); b.innerHTML = html;
    b.dataset.cost = cost; b.addEventListener('click', fn); el.panel.appendChild(b); return b;
  };
  const info = (html) => { const d = document.createElement('div'); d.className = 'info'; d.innerHTML = html; el.panel.appendChild(d); return d; };
  const showTop = (y) => { el.panel.className = y > WORLD_H * 0.52 ? 'top' : 'bottom'; };
  const ore = world.layout.ore || [];
  if (G.spot && G.spot.patch !== undefined) {
    const p = ore[G.spot.patch], R = RESOURCES[p.res], cost = discount(DRILL.cost, FX.towerDisc);
    showTop(G.spot.y);
    info(`<b>${R.name} patch</b><span>richness x${p.rich.toFixed(2)}</span><span>${R.use}</span>`);
    mkBtn('tcard', `<span class="dot sq" style="border-color:${R.color}"></span><span class="nm">Drill</span><span class="cs">${cost}</span><small>+${drillRate(p, 1, FX).toFixed(2)} ${R.name.toLowerCase()}/s</small>`, placeDrill, cost);
    mkBtn('abtn', 'Close', clearSelection);
  } else if (G.spot) {
    showTop(G.spot.y);
    for (const o of buildOptions()) {
      mkBtn('tcard', `<span class="dot ${DOT[o.kind]}" style="border-color:${o.color}"></span><span class="nm">${escapeHtml(o.name)}</span><span class="cs">${o.cost}</span><small>${o.blurb}</small>`,
        () => placeTower(o), o.cost);
    }
  } else if (G.selectedDrill >= 0 && G.drills[G.selectedDrill]) {
    const d = G.drills[G.selectedDrill], p = ore[d.patch], R = RESOURCES[p.res];
    showTop(d.y);
    info(`<b>${R.name} drill</b><span>level ${d.level} of ${DRILL.mult.length}</span><span>+${drillOut(d).toFixed(2)} ${R.name.toLowerCase()}/s</span>`);
    if (d.level < FX.drillLevels) {
      const c = drillUpgradeCost(d);
      mkBtn('ucard', `<b>Upgrade to level ${d.level + 1}</b><small>Output x${(DRILL.mult[d.level] / DRILL.mult[d.level - 1]).toFixed(2)}, now +${drillRate(p, d.level + 1, FX).toFixed(2)}/s</small><span class="cs">${c}</span>`, upgradeDrill, c);
    } else if (d.level < DRILL.mult.length) {
      info('<b>Level 3 locked</b><span>Research Deep Boring</span>');
    } else info('<b>Fully upgraded</b>');
    mkBtn('abtn', `Sell<b>+${drillSellValue(d)}</b>`, sellDrill);
    mkBtn('abtn', 'Close', clearSelection);
  } else if (G.selected >= 0 && G.towers[G.selected]) {
    const t = G.towers[G.selected], st = statsOf(t), opts = choices(t.kind, t.path, FX.towerTier[t.kind]);
    showTop(t.y);
    const last = t.path.length ? NODES[t.kind][t.path[t.path.length - 1]].name : 'Base';
    const dry = isStarved(G.starved, t.kind);
    info(`<b>${escapeHtml(t.name)}</b><span>${last}</span><span>${statLine(t.kind, st)}</span><span>range ${Math.round(st.range)}</span>
      <span class="${dry ? 'bad' : ''}">${dry ? 'OUT OF AMMO' : ammoText(t.kind, FX)}</span>`);
    for (const n of opts) {
      const c = upgradeCost(t.kind, n);
      mkBtn('ucard', `<b>${n.name}</b><small>${n.desc}</small><span class="cs">${c}</span>`, () => buyNode(n.id), c);
    }
    if (opts.length > 1) { const h = document.createElement('div'); h.className = 'pick'; h.textContent = 'Pick one'; el.panel.insertBefore(h, el.panel.children[1]); }
    if (!opts.length) {
      const next = t.path.length >= 5 ? 0 : t.path.length + 1;
      if (next >= 4 && FX.towerTier[t.kind] < next) info(`<b>Tier ${next} locked</b><span>Research ${tierResearch(t.kind, next)}</span>`);
      else info('<b>Fully upgraded</b>');
    }
    mkBtn('abtn', 'Upgrade tree', openTree);
    mkBtn('abtn', `Sell<b>+${sellValue(t)}</b>`, sellTower);
    mkBtn('abtn', 'Close', clearSelection);
  }
}

// ---------- upgrade tree overlay ----------
function openTree() { el.tree.classList.remove('hidden'); renderTree(); }
function closeTree() { el.tree.classList.add('hidden'); }
function renderTree() {
  if (el.tree.classList.contains('hidden')) return;
  const t = G.towers[G.selected];
  if (!t) return closeTree();
  const tree = TREES[t.kind], N = NODES[t.kind], unlocked = FX.towerTier[t.kind], path = t.path;
  const avail = new Set(choices(t.kind, path, unlocked).map((n) => n.id));
  el.treeTitle.textContent = `${t.name} upgrade tree`;
  el.treeGold.textContent = Math.floor(G.gold);
  const state = (n) => {
    if (path.includes(n.id)) return 'owned';
    if (avail.has(n.id)) return 'avail';
    // a sibling of a node already taken (or a child of a rejected parent) is gone for good
    if (n.tier === 1 && path.length >= 1) return 'out';
    if (n.tier === 2 && ((path.length >= 1 && path[0] !== n.parent) || path.length >= 2)) return 'out';
    if (n.tier === 4 && ((path.length >= 2 && path[1] !== n.parent) || path.length >= 4)) return 'out';
    if (n.tier === 5 && path.length >= 5) return 'out';
    if (n.tier > unlocked) return 'rlock';
    return 'future';
  };
  const card = (n) => {
    const st = state(n), cost = upgradeCost(t.kind, n);
    const dim = st === 'avail' && G.gold < cost ? ' dim' : '';
    const tag = st === 'owned' ? 'Owned' : st === 'out' ? 'Locked out' : st === 'rlock' ? `Research: ${tierResearch(t.kind, n.tier)}` : cost;
    return `<button class="tnode ${st}${dim}" data-id="${n.id}" ${st === 'avail' ? '' : 'disabled'}><b>${n.name}</b><small>${n.desc}</small><span class="cs">${tag}</span></button>`;
  };
  const t1 = tree.filter((n) => n.tier === 1);
  let html = '<div class="tgrid"><h4>Tier 1: path</h4><h4>Tier 2: specialty</h4><h4>Tier 3: capstone</h4><h4>Tier 4: mastery</h4><h4>Tier 5: ultimate</h4>';
  t1.forEach((p, i) => {
    html += `<div class="cell c1" style="grid-column:1;grid-row:${2 + 2 * i} / span 2">${card(p)}</div>`;
    tree.filter((n) => n.parent === p.id).forEach((n, j) => {
      const row = 2 + 2 * i + j;
      html += `<div class="cell link" style="grid-column:2;grid-row:${row}">${card(n)}</div>`;
      const m = tree.find((x) => x.tier === 4 && x.parent === n.id);
      html += `<div class="cell link" style="grid-column:4;grid-row:${row}">${card(m)}</div>`;
    });
  });
  html += `<div class="cell link span" style="grid-column:3;grid-row:2 / span 4">${card(N.master)}</div>`;
  html += `<div class="cell link span col" style="grid-column:5;grid-row:2 / span 4">${tree.filter((n) => n.tier === 5).map(card).join('')}</div></div>`;
  html += '<p class="muted">Each choice locks out its alternatives for this tower. Tiers 4 and 5 are opened in the research tree. Selling the tower resets the tree.</p>';
  el.treeBody.innerHTML = html;
  for (const b of el.treeBody.querySelectorAll('button.tnode.avail')) b.addEventListener('click', () => buyNode(b.dataset.id));
}

// ---------- waves ----------
function launchWave() {
  G.wave++;
  const spec = waveSpec(G.wave);
  G.queue.push({ spec, emitted: new Array(ENEMIES.length).fill(0), elapsed: 0 });
  G.gold += WAVE_BONUS(G.wave) + FX.waveBonus;
  G.nextIn = WAVE_GAP;
  // introduce each new enemy type once, the first time it shows up
  for (let k = 1; k < ENEMIES.length; k++) {
    if (spec.counts[k] > 0 && !G.seenKinds.has(k)) {
      G.seenKinds.add(k);
      if (k > 4) toast(`New enemy: ${ENEMIES[k].name}. ${ENEMIES[k].desc}`, 4200);
    }
  }
  updateHud();
}

function makeStep(dt) {
  G.time += dt; G.frame++;
  if (G.nextIn > 0) { G.nextIn -= dt; if (G.nextIn <= 0) launchWave(); }
  if (!G.plan && G.queue.length) G.plan = G.queue.shift();
  const counts = new Array(16).fill(0);
  let hpScale = 1, total = 0;
  if (G.plan) {
    const p = G.plan;
    p.elapsed += dt;
    const frac = Math.min(1, p.elapsed / p.spec.duration);
    for (let k = 1; k < ENEMIES.length; k++) {
      const due = Math.floor(p.spec.counts[k] * frac) - p.emitted[k];
      if (due > 0) { counts[k] = due; p.emitted[k] += due; total += due; }
    }
    hpScale = p.spec.hpScale;
    if (frac >= 1) G.plan = null;
  }
  const spawnStart = G.ring;
  G.ring = (G.ring + total) % MAX_ENEMIES;
  G.spawned += total;
  return {
    dt, time: G.time, spawnStart, numTowers: G.towerCount, hpScale, goldMult: curGoldMult(), spdScale: 1 - FX.enemySlow,
    spawnY0: map.spawnY0, spawnY1: map.spawnY1, maxUsed: Math.min(MAX_ENEMIES, G.spawned), frame: G.frame, counts,
  };
}
function curGoldMult() { return waveSpec(Math.max(1, G.wave)).goldMult * (1 + FX.bounty); }

// ---------- HUD ----------
function updateHud() {
  el.gold.textContent = Math.floor(G.gold);
  el.lives.textContent = G.lives; el.lives.classList.toggle('warn', G.lives <= 5);
  el.wave.textContent = G.wave;
  el.alive.textContent = gpu ? gpu.alive : 0;
  el.next.textContent = G.running ? `${Math.max(0, Math.ceil(G.nextIn))}s` : '-';
  for (const r of RES_IDS) {
    el[r].textContent = Math.floor(G.stock[r]);
    const net = G.flow[r] - G.flow['spend' + (r === 'iron' ? 'Iron' : 'Coal')];
    el[r + 'R'].textContent = G.running ? `${net >= 0 ? '+' : '-'}${Math.abs(net).toFixed(1)}/s` : '';
    el[r].classList.toggle('warn', G.running && (G.starved[r] || (G.stock[r] < 25 && net < 0)));
  }
}
let lastGoldShown = -1;

function pullCounters() {
  const c = gpu.counters;
  const dk = c.kills - G.seen.kills, dg = c.gold - G.seen.gold, dl = c.leaks - G.seen.leaks;
  G.seen = { kills: c.kills, gold: c.gold, leaks: c.leaks };
  if (dk) G.kills += dk;
  if (dg) G.gold += dg;
  if (dl) { G.lives = Math.max(0, G.lives - dl); if (G.lives <= 0 && !G.over) gameOver(); }
}

// Mining income and ammunition bills. Rates are smoothed for the HUD.
function tickEconomy(sim) {
  const inc = mine(G.stock, world.layout.ore, G.drills, FX, sim);
  const spent = billAmmo(G.stock, G.towers, gpu.usage, G.usagePrev, FX);
  const k = Math.min(1, sim * 1.5);
  if (sim > 0) {
    G.flow.iron += (inc.iron - G.flow.iron) * k; G.flow.coal += (inc.coal - G.flow.coal) * k;
    G.flow.spendIron += (spent.iron / sim - G.flow.spendIron) * k; G.flow.spendCoal += (spent.coal / sim - G.flow.spendCoal) * k;
  }
  if (updateStarved(G.starved, G.stock)) {
    syncTowers();
    for (const r of RES_IDS) {
      if (G.starved[r] && !G.warned[r] && G.towers.some((t) => t && AMMO[t.kind].res === r)) {
        G.warned[r] = true;
        toast(`Out of ${RESOURCES[r].name.toLowerCase()}: ${r === 'iron' ? 'guns and mortars' : 'flames and lasers'} stopped`, 2600);
      }
      if (!G.starved[r]) G.warned[r] = false;
    }
    if (G.selected >= 0) renderPanel();
  }
}

// ---------- map ----------
function applyWorld(w) {
  world = w; map = w.map; build = makeBuildCheck(map);
  if (gpu) gpu.setField(map.field);
  drawTerrain(); drawPreview(); refreshMapUi();
}
function refreshMapUi() {
  const random = meta.map.mode === 'random';
  el.mMapSketch.classList.toggle('on', !random); el.mMapRandom.classList.toggle('on', random);
  el.mReroll.classList.toggle('hidden', !random);
  el.mSeed.textContent = random
    ? `Seed ${world.seed}${world.attempts > 1 ? `, re-rolled ${world.attempts - 1}x to remove dead-end pockets` : ''}`
    : 'The hand-drawn canyon';
}
function pickMap(mode, seed) {
  meta.map = { mode, seed: mode === 'random' ? seed : 0 };
  const busy = (on) => { el.mReroll.disabled = on; el.mMapRandom.disabled = on; el.mMapSketch.disabled = on; el.mPlay.disabled = on || !gpu; if (on) el.mSeed.textContent = 'Generating...'; };
  busy(true);
  setTimeout(() => {
    applyWorld(mode === 'random' ? generateMap(seed) : sketch);
    if (mode === 'random') meta.map.seed = world.seed;
    saveMeta(meta); busy(false);
  }, 30);
}

// ---------- flow ----------
function newGame() {
  FX = effects(meta);
  gpu.reset();
  Object.assign(G, {
    running: true, paused: false, over: false, speed: 1, gold: START_GOLD + FX.startGold, lives: START_LIVES + FX.lives, wave: 0, kills: 0,
    towers: new Array(MAX_TOWERS).fill(null), towerCount: 0, selected: -1, spot: null, hover: null,
    nextIn: FIRST_WAVE_DELAY, queue: [], plan: null, ring: 0, spawned: 0, frame: 0, time: 0,
    seen: { kills: 0, gold: 0, leaks: 0 }, seenKinds: new Set(),
    stock: newStock(FX), starved: { iron: false, coal: false }, drills: [], selectedDrill: -1,
    usagePrev: new Float32Array(MAX_TOWERS), flow: { iron: 0, coal: 0, spendIron: 0, spendCoal: 0 }, warned: { iron: false, coal: false },
  });
  el.bSpeed.textContent = '1x'; el.bPause.textContent = 'Pause';
  el.menu.classList.add('hidden'); el.over.classList.add('hidden');
  renderPanel(); updateHud();
}
function gameOver() {
  G.over = true;
  const earned = shardsFor(G.wave, G.kills);
  meta.shards += earned;
  meta.best = Math.max(meta.best || 0, G.wave);
  saveMeta(meta);
  el.oWave.textContent = G.wave; el.oKills.textContent = G.kills; el.oBest.textContent = meta.best; el.oShards.textContent = `+${earned}`;
  clearSelection();
  setTimeout(() => el.over.classList.remove('hidden'), 500);
}
function refreshMenu() {
  el.mShards.textContent = meta.shards;
  el.mBest.textContent = meta.best ? `Best wave ${meta.best}` : '';
}

const research = initResearch({ root: $('research'), body: $('resBody'), points: $('resPoints'), close: $('resClose'), meta,
  onChange: () => { FX = effects(meta); refreshMenu(); } });
const shop = initWorkshop({ root: $('workshop'), body: $('wsBody'), slotsEl: $('wsSlots'), close: $('wsClose'), meta, getFx: () => FX,
  onChange: () => { if (G.spot) renderPanel(); } });
let pausedByShop = false;
shop.onClose = () => { if (G.over) el.over.classList.remove('hidden'); if (pausedByShop) { G.paused = false; pausedByShop = false; el.bPause.textContent = 'Pause'; } renderPanel(); };
$('resClose').addEventListener('click', () => { if (G.over) el.over.classList.remove('hidden'); });
const openResearch = () => { el.over.classList.add('hidden'); research.open(); };
const openShop = () => { shop.open(); };

let lastT = performance.now();
function loop(now) {
  const real = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const steps = [];
  if (G.running && !G.paused && !G.over && gpu) {
    const sim = real * G.speed;
    const n = Math.max(1, Math.min(8, Math.ceil(sim / (1 / 60))));
    for (let i = 0; i < n; i++) steps.push(makeStep(sim / n));
  }
  if (gpu) {
    gpu.frame(steps, { time: now / 1000 });
    if (G.running) pullCounters();
    if (G.running && !G.over && !G.paused) tickEconomy(steps.reduce((a, st) => a + st.dt, 0));
    const gShown = Math.floor(G.gold);
    if (gShown !== lastGoldShown) { lastGoldShown = gShown; refreshPanel(); if (!el.tree.classList.contains('hidden')) { el.treeGold.textContent = gShown; for (const b of el.treeBody.querySelectorAll('button.tnode.avail')) b.classList.toggle('dim', G.gold < upgradeCost(G.towers[G.selected].kind, NODES[G.towers[G.selected].kind][b.dataset.id])); } }
    updateHud();
    drawUi(now / 1000);
  }
  requestAnimationFrame(loop);
}

// ---------- input ----------
function worldPos(e) {
  const r = el.cU.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * WORLD_W, y: ((e.clientY - r.top) / r.height) * WORLD_H };
}
el.cU.addEventListener('pointerdown', (e) => {
  if (!G.running || G.over) return;
  const p = worldPos(e);
  const ti = towerAt(p.x, p.y);
  if (ti >= 0) { G.selected = ti; G.spot = null; G.selectedDrill = -1; renderPanel(); return; }
  const di = drillAt(G.drills, p.x, p.y);
  if (di >= 0) { G.selectedDrill = di; G.selected = -1; G.spot = null; closeTree(); renderPanel(); return; }
  if (patchAt(world.layout.ore, p.x, p.y) >= 0) {
    const c = canDrill(world.layout.ore, G.drills, p.x, p.y);
    if (c.ok) { G.spot = { x: p.x, y: p.y, patch: c.patch }; G.selected = -1; G.selectedDrill = -1; renderPanel(); } else toast(c.why);
    return;
  }
  if (build.rockDepth(p.x, p.y) > 0) {
    if (canPlace(p.x, p.y)) { G.spot = p; G.selected = -1; G.selectedDrill = -1; renderPanel(); }
    else { const near = G.towers.some((t) => t && Math.hypot(t.x - p.x, t.y - p.y) < TOWER_SPACING); toast(near ? 'Too close to another tower' : 'Too close to the rock edge'); }
    return;
  }
  clearSelection();
  if (e.pointerType !== 'mouse') toast('Towers go on the rocks, drills on the ore');
});
el.cU.addEventListener('pointermove', (e) => { G.hover = e.pointerType === 'mouse' ? worldPos(e) : null; });
el.cU.addEventListener('pointerleave', () => { G.hover = null; });

el.treeClose.addEventListener('click', closeTree);
el.bShop.addEventListener('click', () => {
  if (G.running && !G.over && !G.paused) { G.paused = true; pausedByShop = true; el.bPause.textContent = 'Resume'; }
  openShop();
});
el.mResearch.addEventListener('click', openResearch);
el.mShop.addEventListener('click', openShop);
el.oResearch.addEventListener('click', openResearch);
el.oShop.addEventListener('click', () => { el.over.classList.add('hidden'); openShop(); });
el.bPause.addEventListener('click', () => { G.paused = !G.paused; el.bPause.textContent = G.paused ? 'Resume' : 'Pause'; });
el.bSpeed.addEventListener('click', () => { G.speed = G.speed >= 3 ? 1 : G.speed + 1; el.bSpeed.textContent = `${G.speed}x`; });
el.mMapSketch.addEventListener('click', () => { if (meta.map.mode !== 'sketch') pickMap('sketch', 0); });
el.mMapRandom.addEventListener('click', () => { if (meta.map.mode !== 'random') pickMap('random', meta.map.seed || Math.floor(Math.random() * 1e6)); });
el.mReroll.addEventListener('click', () => pickMap('random', Math.floor(Math.random() * 1e6)));
el.mPlay.addEventListener('click', newGame);
el.oRetry.addEventListener('click', newGame);
el.oMenu.addEventListener('click', () => { el.over.classList.add('hidden'); el.menu.classList.remove('hidden'); G.running = false; refreshMenu(); updateHud(); });
window.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); el.bPause.click(); } if (e.code === 'Escape') clearSelection(); });
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------- boot ----------
resize();
(async () => {
  try {
    gpu = await createGpu(el.cG, map);
    gpu.reset();
    if (meta.map.mode === 'random') applyWorld(generateMap(meta.map.seed || undefined));
    el.mPlay.disabled = false; el.mPlay.textContent = 'Play'; refreshMenu();
  } catch (err) {
    console.error(err);
    el.mError.textContent = `${err.message || err} Try Safari on iPadOS 26 or a current Chrome or Edge.`;
    el.mError.classList.remove('hidden');
    el.mPlay.textContent = 'WebGPU unavailable';
  }
  requestAnimationFrame(loop);
})();
drawPreview(); refreshMapUi(); refreshMenu();
window.__tod = { gameOver, G, meta, get FX() { return FX; }, get gpu() { return gpu; }, get map() { return map; }, get world() { return world; }, pickMap, newGame, launchWave, makeStep, pullCounters, updateHud, syncTowers, statsOf };

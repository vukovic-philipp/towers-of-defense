import {
  WORLD_W, WORLD_H, MAX_ENEMIES, MAX_TOWERS, TOWERS, TREES, NODES, SELL_RATIO, TOWER_SPACING,
  START_GOLD, START_LIVES, FIRST_WAVE_DELAY, WAVE_GAP, WAVE_BONUS, ENEMIES, waveSpec,
  choices, nodeCost, towerStats, statLine,
} from './data.js';
import { buildField, makeBuildCheck, WALLS, ROCKS } from './map.js';
import { createGpu } from './gpu.js';
import { loadMeta, saveMeta, effects, shardsFor } from './meta.js';
import { sanitize, designBase, designCost, discount } from './design.js';
import { initResearch } from './research.js';
import { initWorkshop } from './workshop.js';

const $ = (id) => document.getElementById(id);
const el = {
  gold: $('hGold'), lives: $('hLives'), wave: $('hWave'), alive: $('hAlive'), next: $('hNext'),
  bShop: $('bShop'), bPause: $('bPause'), bSpeed: $('bSpeed'),
  board: $('board'), stage: $('stage'), cT: $('cTerrain'), cG: $('cGpu'), cU: $('cUi'),
  panel: $('panel'), toast: $('toast'),
  menu: $('menu'), mPlay: $('mPlay'), mError: $('mError'), mResearch: $('mResearch'), mShop: $('mShop'), mShards: $('mShards'), mBest: $('mBest'),
  tree: $('tree'), treeBody: $('treeBody'), treeTitle: $('treeTitle'), treeGold: $('treeGold'), treeClose: $('treeClose'),
  over: $('over'), oWave: $('oWave'), oKills: $('oKills'), oBest: $('oBest'), oRetry: $('oRetry'), oMenu: $('oMenu'), oShards: $('oShards'), oResearch: $('oResearch'), oShop: $('oShop'),
};

const map = buildField();
const build = makeBuildCheck(map);
let gpu = null;
const meta = loadMeta();
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
function drawTerrain() {
  const ctx = el.cT.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#0d1218';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  // faint ruled lines, a nod to the paper sketch
  ctx.strokeStyle = 'rgba(139,152,165,0.045)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 40; x < WORLD_W; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); }
  ctx.stroke();
  // entry and gate glow
  let g = ctx.createLinearGradient(0, 0, 90, 0); g.addColorStop(0, 'rgba(94,234,212,0.10)'); g.addColorStop(1, 'rgba(94,234,212,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 90, WORLD_H);
  g = ctx.createLinearGradient(WORLD_W, 0, WORLD_W - 110, 0); g.addColorStop(0, 'rgba(240,113,120,0.22)'); g.addColorStop(1, 'rgba(240,113,120,0)');
  ctx.fillStyle = g; ctx.fillRect(WORLD_W - 110, 0, 110, WORLD_H);

  for (const w of WALLS) {
    poly(ctx, w); ctx.fillStyle = '#06080b'; ctx.fill();
    ctx.strokeStyle = '#222c38'; ctx.lineWidth = 2; ctx.stroke();
  }
  for (const r of ROCKS) {
    poly(ctx, r); ctx.fillStyle = '#18202a'; ctx.fill();
    ctx.save(); ctx.clip(); ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 22; poly(ctx, r); ctx.stroke(); ctx.restore();
    poly(ctx, r); ctx.strokeStyle = '#34414f'; ctx.lineWidth = 2; ctx.stroke();
  }
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
  if (G.selected >= 0 && G.towers[G.selected]) {
    const t = G.towers[G.selected], rg = statsOf(t).range;
    ctx.fillStyle = 'rgba(230,237,243,0.04)'; ctx.beginPath(); ctx.arc(t.x, t.y, rg, 0, 6.2832); ctx.fill();
    ring(t.x, t.y, rg, t.color, true, 0.8);
    ring(t.x, t.y, 21, '#e6edf3', false);
  }
  if (G.spot) {
    const pulse = 0.6 + 0.4 * Math.sin(time * 6);
    ring(G.spot.x, G.spot.y, 17, '#e6edf3', true, pulse);
    ctx.fillStyle = '#e6edf3'; ctx.beginPath(); ctx.arc(G.spot.x, G.spot.y, 2.5, 0, 6.2832); ctx.fill();
  }
  if (G.hover && !G.spot && G.selected < 0) {
    const ok = canPlace(G.hover.x, G.hover.y);
    ring(G.hover.x, G.hover.y, 15, ok ? '#5eead4' : '#f07178', false, 0.55);
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
  gpu.uploadTowers(G.towers.map((t) => t && { x: t.x, y: t.y, kind: t.kind, tier: t.path.length, stats: statsOf(t), color: hexRgb(t.color) }),
    resetSlot === undefined ? [] : [resetSlot]);
}
function placeTower(opt) {
  if (!G.spot || G.gold < opt.cost) return;
  const slot = G.towers.findIndex((t) => !t);
  if (slot < 0) return toast('Tower limit reached');
  G.gold -= opt.cost;
  G.towers[slot] = { kind: opt.kind, path: [], x: G.spot.x, y: G.spot.y, base: opt.base, color: opt.color, name: opt.name, invested: opt.cost };
  G.spot = null; G.selected = slot;
  syncTowers(slot); renderPanel(); updateHud();
}
function buyNode(id) {
  const t = G.towers[G.selected]; if (!t) return;
  const n = choices(t.kind, t.path).find((c) => c.id === id);
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
function refreshPanel() {
  for (const b of el.panel.children) if (b.dataset.cost !== undefined) b.classList.toggle('dim', G.gold < +b.dataset.cost);
}
function clearSelection() { G.spot = null; G.selected = -1; closeTree(); renderPanel(); }

let toastTimer = 0;
function toast(msg, ms = 1400) {
  el.toast.textContent = msg; el.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

const DOT = ['', 'dia', '', 'sq'];
function escapeHtml(x) { return String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function renderPanel() {
  el.panel.innerHTML = '';
  const mkBtn = (cls, html, fn, cost = 0) => {
    const b = document.createElement('button'); b.className = cls + (G.gold < cost ? ' dim' : ''); b.innerHTML = html;
    b.dataset.cost = cost; b.addEventListener('click', fn); el.panel.appendChild(b); return b;
  };
  const showTop = (y) => { el.panel.className = y > WORLD_H * 0.52 ? 'top' : 'bottom'; };
  if (G.spot) {
    showTop(G.spot.y);
    for (const o of buildOptions()) {
      mkBtn('tcard', `<span class="dot ${DOT[o.kind]}" style="border-color:${o.color}"></span><span class="nm">${escapeHtml(o.name)}</span><span class="cs">${o.cost}</span><small>${o.blurb}</small>`,
        () => placeTower(o), o.cost);
    }
  } else if (G.selected >= 0 && G.towers[G.selected]) {
    const t = G.towers[G.selected], st = statsOf(t), opts = choices(t.kind, t.path);
    showTop(t.y);
    const info = document.createElement('div'); info.className = 'info';
    const last = t.path.length ? NODES[t.kind][t.path[t.path.length - 1]].name : 'Base';
    info.innerHTML = `<b>${escapeHtml(t.name)}</b><span>${last}</span><span>${statLine(t.kind, st)}</span><span>range ${Math.round(st.range)}</span>`;
    el.panel.appendChild(info);
    for (const n of opts) {
      const c = upgradeCost(t.kind, n);
      mkBtn('ucard', `<b>${n.name}</b><small>${n.desc}</small><span class="cs">${c}</span>`, () => buyNode(n.id), c);
    }
    if (opts.length > 1) { const h = document.createElement('div'); h.className = 'pick'; h.textContent = 'Pick one'; el.panel.insertBefore(h, el.panel.children[1]); }
    if (!opts.length) { const m = document.createElement('div'); m.className = 'info'; m.innerHTML = '<b>Fully upgraded</b>'; el.panel.appendChild(m); }
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
  const tree = TREES[t.kind], N = NODES[t.kind];
  const avail = new Set(choices(t.kind, t.path).map((n) => n.id));
  el.treeTitle.textContent = `${t.name} upgrade tree`;
  el.treeGold.textContent = Math.floor(G.gold);
  const state = (n) => {
    if (t.path.includes(n.id)) return 'owned';
    if (avail.has(n.id)) return 'avail';
    // a sibling of a node already taken (or a child of a rejected parent) is gone for good
    if (n.tier === 1 && t.path.length >= 1) return 'out';
    if (n.tier === 2 && t.path.length >= 1 && t.path[0] !== n.parent) return 'out';
    if (n.tier === 2 && t.path.length >= 2) return 'out';
    return 'future';
  };
  const card = (n, extra = '') => {
    const st = state(n), cost = upgradeCost(t.kind, n);
    const dim = st === 'avail' && G.gold < cost ? ' dim' : '';
    const tag = st === 'owned' ? 'Owned' : st === 'out' ? 'Locked out' : cost;
    return `<button class="tnode ${st}${dim}" data-id="${n.id}" ${st === 'avail' ? '' : 'disabled'} style="${extra}"><b>${n.name}</b><small>${n.desc}</small><span class="cs">${tag}</span></button>`;
  };
  const t1 = tree.filter((n) => n.tier === 1);
  let html = '<div class="tgrid"><h4>Tier 1: path</h4><h4>Tier 2: specialty</h4><h4>Tier 3: capstone</h4>';
  t1.forEach((p, i) => {
    html += `<div class="cell c1" style="grid-row:${i + 2}">${card(p)}</div>`;
    html += `<div class="cell c2 two" style="grid-row:${i + 2}">${tree.filter((n) => n.parent === p.id).map((n) => card(n)).join('')}</div>`;
  });
  html += `<div class="cell c3" style="grid-row:2 / span 2">${card(N.master)}</div></div>`;
  html += '<p class="muted">Each choice locks out its alternatives for this tower. Selling the tower resets the tree.</p>';
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
  const counts = new Array(12).fill(0);
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

// ---------- flow ----------
function newGame() {
  FX = effects(meta);
  gpu.reset();
  Object.assign(G, {
    running: true, paused: false, over: false, speed: 1, gold: START_GOLD + FX.startGold, lives: START_LIVES + FX.lives, wave: 0, kills: 0,
    towers: new Array(MAX_TOWERS).fill(null), towerCount: 0, selected: -1, spot: null, hover: null,
    nextIn: FIRST_WAVE_DELAY, queue: [], plan: null, ring: 0, spawned: 0, frame: 0, time: 0,
    seen: { kills: 0, gold: 0, leaks: 0 }, seenKinds: new Set(),
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
  if (ti >= 0) { G.selected = ti; G.spot = null; renderPanel(); return; }
  if (build.rockDepth(p.x, p.y) > 0) {
    if (canPlace(p.x, p.y)) { G.spot = p; G.selected = -1; renderPanel(); }
    else { const near = G.towers.some((t) => t && Math.hypot(t.x - p.x, t.y - p.y) < TOWER_SPACING); toast(near ? 'Too close to another tower' : 'Too close to the rock edge'); }
    return;
  }
  clearSelection();
  if (e.pointerType !== 'mouse') toast('Towers go on the rocks');
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
    el.mPlay.disabled = false; el.mPlay.textContent = 'Play'; refreshMenu();
  } catch (err) {
    console.error(err);
    el.mError.textContent = `${err.message || err} Try Safari on iPadOS 26 or a current Chrome or Edge.`;
    el.mError.classList.remove('hidden');
    el.mPlay.textContent = 'WebGPU unavailable';
  }
  requestAnimationFrame(loop);
})();
refreshMenu();
window.__tod = { gameOver, G, meta, get FX() { return FX; }, get gpu() { return gpu; }, map, newGame, launchWave, makeStep, pullCounters, updateHud, syncTowers, statsOf };

import {
  WORLD_W, WORLD_H, MAX_ENEMIES, MAX_TOWERS, TOWERS, MAX_LEVEL, SELL_RATIO, TOWER_SPACING, BUILD_DEPTH,
  START_GOLD, START_LIVES, FIRST_WAVE_DELAY, WAVE_GAP, towerValue, waveSpec,
} from './data.js';
import { buildField, makeBuildCheck, WALLS, ROCKS } from './map.js';
import { createGpu } from './gpu.js';

const $ = (id) => document.getElementById(id);
const el = {
  gold: $('hGold'), lives: $('hLives'), wave: $('hWave'), alive: $('hAlive'),
  bWave: $('bWave'), bPause: $('bPause'), bSpeed: $('bSpeed'),
  board: $('board'), stage: $('stage'), cT: $('cTerrain'), cG: $('cGpu'), cU: $('cUi'),
  panel: $('panel'), toast: $('toast'),
  menu: $('menu'), mPlay: $('mPlay'), mError: $('mError'),
  over: $('over'), oWave: $('oWave'), oKills: $('oKills'), oBest: $('oBest'), oRetry: $('oRetry'), oMenu: $('oMenu'),
};

const map = buildField();
const build = makeBuildCheck(map);
let gpu = null;

const G = {
  running: false, paused: false, over: false, speed: 1,
  gold: 0, lives: 0, wave: 0, kills: 0,
  towers: new Array(MAX_TOWERS).fill(null), // slot -> {kind, level, x, y}
  towerCount: 0,                            // high-water mark for the GPU loop
  selected: -1,                             // tower slot
  spot: null,                               // {x, y} pending build location
  hover: null,
  nextIn: 0, queue: [], plan: null,
  ring: 0, spawned: 0, frame: 0, time: 0,
  seen: { kills: 0, gold: 0, leaks: 0 },
  dirty: true,
};

const bestKey = 'towers-of-defense-best';
const getBest = () => { try { return +localStorage.getItem(bestKey) || 0; } catch { return 0; } };
const setBest = (v) => { try { localStorage.setItem(bestKey, String(v)); } catch { /* storage unavailable */ } };

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
    const t = G.towers[G.selected], d = TOWERS[t.kind];
    ctx.fillStyle = 'rgba(230,237,243,0.04)'; ctx.beginPath(); ctx.arc(t.x, t.y, d.range[t.level], 0, 6.2832); ctx.fill();
    ring(t.x, t.y, d.range[t.level], d.color, true, 0.8);
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
function syncTowers(resetSlot) {
  G.towerCount = 0;
  G.towers.forEach((t, i) => { if (t) G.towerCount = i + 1; });
  gpu.uploadTowers(G.towers, resetSlot === undefined ? [] : [resetSlot]);
}
function placeTower(kind) {
  const d = TOWERS[kind];
  if (!G.spot || G.gold < d.cost) return;
  const slot = G.towers.findIndex((t) => !t);
  if (slot < 0) return toast('Tower limit reached');
  G.gold -= d.cost;
  G.towers[slot] = { kind, level: 0, x: G.spot.x, y: G.spot.y };
  G.spot = null; G.selected = slot;
  syncTowers(slot); renderPanel(); updateHud();
}
function upgradeTower() {
  const t = G.towers[G.selected]; if (!t || t.level >= MAX_LEVEL) return;
  const cost = TOWERS[t.kind].upgrade[t.level];
  if (G.gold < cost) return;
  G.gold -= cost; t.level++;
  syncTowers(); renderPanel(); updateHud();
}
function sellTower() {
  const t = G.towers[G.selected]; if (!t) return;
  G.gold += Math.floor(towerValue(t) * SELL_RATIO);
  const slot = G.selected;
  G.towers[slot] = null; G.selected = -1;
  syncTowers(slot); renderPanel(); updateHud();
}
function refreshPanel() {
  for (const b of el.panel.children) if (b.dataset.cost !== undefined) b.classList.toggle('dim', G.gold < +b.dataset.cost);
}
function clearSelection() { G.spot = null; G.selected = -1; renderPanel(); }

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg; el.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1400);
}

const DOT = ['', 'dia', '', 'sq'];
function renderPanel() {
  el.panel.innerHTML = '';
  const mkBtn = (cls, html, fn, cost = 0) => {
    const b = document.createElement('button'); b.className = cls + (G.gold < cost ? ' dim' : ''); b.innerHTML = html;
    b.dataset.cost = cost; b.addEventListener('click', fn); el.panel.appendChild(b); return b;
  };
  const showTop = (y) => { el.panel.className = y > WORLD_H * 0.52 ? 'top' : 'bottom'; };
  if (G.spot) {
    showTop(G.spot.y);
    TOWERS.forEach((d, k) => mkBtn('tcard',
      `<span class="dot ${DOT[k]}" style="border-color:${d.color}"></span><span class="nm">${d.name}</span><span class="cs">${d.cost}</span><small>${d.blurb}</small>`,
      () => placeTower(k), d.cost));
  } else if (G.selected >= 0 && G.towers[G.selected]) {
    const t = G.towers[G.selected], d = TOWERS[t.kind];
    showTop(t.y);
    const info = document.createElement('div'); info.className = 'info';
    info.innerHTML = `<b>${d.name} level ${t.level + 1}</b><span>${d.stat(t.level)}</span><span>range ${d.range[t.level]}</span>`;
    el.panel.appendChild(info);
    if (t.level < MAX_LEVEL) {
      const c = d.upgrade[t.level];
      mkBtn('abtn', `Upgrade<b>${c}</b>`, upgradeTower, c);
    } else {
      const b = mkBtn('abtn', 'Max level', () => {}); b.disabled = true;
    }
    mkBtn('abtn', `Sell<b>+${Math.floor(towerValue(t) * SELL_RATIO)}</b>`, sellTower);
    mkBtn('abtn', 'Close', clearSelection);
  }
}

// ---------- waves ----------
function launchWave(early) {
  G.wave++;
  const spec = waveSpec(G.wave);
  G.queue.push({ spec, emitted: [0, 0, 0, 0, 0], elapsed: 0 });
  G.gold += 15 + 3 * G.wave;
  if (early) G.gold += Math.floor(Math.max(0, G.nextIn) * 0.8);
  G.nextIn = WAVE_GAP;
  updateHud();
}

function makeStep(dt) {
  G.time += dt; G.frame++;
  if (G.nextIn > 0) { G.nextIn -= dt; if (G.nextIn <= 0) launchWave(false); }
  if (!G.plan && G.queue.length) G.plan = G.queue.shift();
  const counts = [0, 0, 0, 0];
  let hpScale = 1;
  if (G.plan) {
    const p = G.plan;
    p.elapsed += dt;
    const frac = Math.min(1, p.elapsed / p.spec.duration);
    for (let k = 1; k <= 4; k++) {
      const due = Math.floor(p.spec.counts[k] * frac) - p.emitted[k];
      if (due > 0) { counts[k - 1] = due; p.emitted[k] += due; }
    }
    hpScale = p.spec.hpScale;
    if (frac >= 1) G.plan = null;
  }
  const total = counts[0] + counts[1] + counts[2] + counts[3];
  const spawnStart = G.ring;
  G.ring = (G.ring + total) % MAX_ENEMIES;
  G.spawned += total;
  return {
    dt, time: G.time, spawnStart, numTowers: G.towerCount, hpScale, goldMult: curGoldMult(),
    spawnY0: map.spawnY0, spawnY1: map.spawnY1, maxUsed: Math.min(MAX_ENEMIES, G.spawned), frame: G.frame, counts,
  };
}
function curGoldMult() { return waveSpec(Math.max(1, G.wave)).goldMult; }

// ---------- HUD ----------
function updateHud() {
  el.gold.textContent = Math.floor(G.gold);
  el.lives.textContent = G.lives; el.lives.classList.toggle('warn', G.lives <= 5);
  el.wave.textContent = G.wave;
  el.alive.textContent = gpu ? gpu.alive : 0;
  if (!G.running) return;
  if (G.wave === 0) el.bWave.textContent = `Start wave 1  ${Math.max(0, Math.ceil(G.nextIn))}s`;
  else el.bWave.textContent = `Next wave ${G.wave + 1}  ${Math.max(0, Math.ceil(G.nextIn))}s`;
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
  gpu.reset();
  Object.assign(G, {
    running: true, paused: false, over: false, speed: 1, gold: START_GOLD, lives: START_LIVES, wave: 0, kills: 0,
    towers: new Array(MAX_TOWERS).fill(null), towerCount: 0, selected: -1, spot: null, hover: null,
    nextIn: FIRST_WAVE_DELAY, queue: [], plan: null, ring: 0, spawned: 0, frame: 0, time: 0,
    seen: { kills: 0, gold: 0, leaks: 0 },
  });
  el.bSpeed.textContent = '1x'; el.bPause.textContent = 'Pause';
  el.menu.classList.add('hidden'); el.over.classList.add('hidden');
  renderPanel(); updateHud();
}
function gameOver() {
  G.over = true;
  const best = Math.max(getBest(), G.wave);
  setBest(best);
  el.oWave.textContent = G.wave; el.oKills.textContent = G.kills; el.oBest.textContent = best;
  clearSelection();
  setTimeout(() => el.over.classList.remove('hidden'), 500);
}

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
    if (gShown !== lastGoldShown) { lastGoldShown = gShown; refreshPanel(); }
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

el.bWave.addEventListener('click', () => { if (G.running && !G.over) launchWave(true); });
el.bPause.addEventListener('click', () => { G.paused = !G.paused; el.bPause.textContent = G.paused ? 'Resume' : 'Pause'; });
el.bSpeed.addEventListener('click', () => { G.speed = G.speed >= 3 ? 1 : G.speed + 1; el.bSpeed.textContent = `${G.speed}x`; });
el.mPlay.addEventListener('click', newGame);
el.oRetry.addEventListener('click', newGame);
el.oMenu.addEventListener('click', () => { el.over.classList.add('hidden'); el.menu.classList.remove('hidden'); G.running = false; });
window.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); el.bPause.click(); } if (e.code === 'Escape') clearSelection(); });
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------- boot ----------
resize();
(async () => {
  try {
    gpu = await createGpu(el.cG, map);
    gpu.reset();
    el.mPlay.disabled = false; el.mPlay.textContent = 'Play';
  } catch (err) {
    console.error(err);
    el.mError.textContent = `${err.message || err} Try Safari on iPadOS 26 or a current Chrome or Edge.`;
    el.mError.classList.remove('hidden');
    el.mPlay.textContent = 'WebGPU unavailable';
  }
  requestAnimationFrame(loop);
})();
window.__tod = { G, get gpu() { return gpu; }, map, newGame, launchWave, makeStep, pullCounters, updateHud };

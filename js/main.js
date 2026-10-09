import { TOWERS, TOWER_ORDER, TARGET_MODES, MAX_LEVEL, TECH, BRANCHES } from './data.js';
import { Game } from './sim.js';
import { Renderer } from './render.js';
import { loadMeta, saveMeta, computeMods, techStatus, buyTech } from './meta.js';

const $ = s => document.querySelector(s);
const meta = loadMeta();
const canvas = $('#c'), stage = $('#stage'), panel = $('#panel');
const renderer = new Renderer(canvas);

let game = null, state = 'menu';
const ui = { selPoint: null, selTower: null, paused: false };
let speed = 1;

// ---------- layout ----------
function layout() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (w > 0 && h > 0) renderer.resize(w, h);
}
new ResizeObserver(layout).observe(stage);

/** Simulation frame for the current screen: height = screen height, length (flow direction) follows the aspect. */
function arenaDims() {
  const aspect = Math.min(2.3, Math.max(1.25, stage.clientWidth / Math.max(1, stage.clientHeight)));
  return { w: 440, h: Math.round(440 * aspect) };
}

// ---------- overlays ----------
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');
function refreshMenu() {
  $('#mShards').textContent = `${meta.rp} shards`;
  $('#mBest').textContent = meta.runs ? `Best: wave ${meta.bestWave}  |  ${meta.bestKills} balls in one run` : '';
}
function openMenu() { state = 'menu'; refreshMenu(); hide('#tech'); hide('#over'); show('#menu'); }
function openTech(from) {
  renderTech(); hide('#menu'); hide('#over'); show('#tech');
  $('#tBack').onclick = () => { hide('#tech'); from === 'over' ? show('#over') : openMenu(); };
}
function renderTech() {
  $('#tShards').textContent = meta.rp;
  const list = $('#techList');
  list.innerHTML = '';
  for (const br of BRANCHES) {
    const col = document.createElement('div'); col.className = 'branch';
    col.innerHTML = `<h3>${br}</h3>`;
    for (const node of TECH.filter(t => t.branch === br)) {
      const s = techStatus(meta, node.id);
      const el = document.createElement('div');
      el.className = 'node' + (s.missing.length ? ' locked' : '');
      el.innerHTML = `<div class="t"><b>${node.name}<span class="lv">${s.lvl}/${node.max}</span></b><span>${node.desc}</span>` +
        (s.missing.length && !s.maxed ? `<em>Requires ${s.missing.join(', ')}</em>` : '') + `</div>`;
      const b = document.createElement('button');
      b.textContent = s.maxed ? 'Maxed' : `${s.cost} shards`;
      b.disabled = !s.canBuy;
      b.onclick = () => { if (buyTech(meta, node.id)) { renderTech(); refreshMenu(); } };
      el.appendChild(b); col.appendChild(el);
    }
    list.appendChild(col);
  }
}

// ---------- run lifecycle ----------
function startRun() {
  layout();
  game = new Game(computeMods(meta.levels), (Math.random() * 1e9) | 0, arenaDims());
  ui.selPoint = ui.selTower = null; ui.paused = false; speed = 1; acc = 0;
  $('#bPause').textContent = 'Pause'; $('#bSpeed').textContent = '1x';
  state = 'play';
  hide('#menu'); hide('#tech'); hide('#over');
}
function endRun() {
  state = 'over';
  const shards = game.shards();
  meta.rp += shards; meta.runs++;
  meta.bestWave = Math.max(meta.bestWave, game.wave);
  const newBest = game.kills > meta.bestKills; meta.bestKills = Math.max(meta.bestKills, game.kills);
  saveMeta(meta);
  $('#oWave').textContent = game.wave;
  $('#oKills').textContent = game.kills;
  $('#oShards').textContent = '+' + shards;
  $('#oBest').textContent = `Best wave: ${meta.bestWave}` + (newBest ? '  |  new kill record' : '');
  show('#over');
}
$('#mPlay').onclick = startRun;
$('#mTech').onclick = () => openTech('menu');
$('#oRetry').onclick = startRun;
$('#oTech').onclick = () => openTech('over');
$('#oMenu').onclick = openMenu;

// ---------- controls ----------
$('#bWave').onclick = () => { if (game && state === 'play') game.skipCountdown(); };
$('#bPause').onclick = () => {
  if (state !== 'play') return;
  ui.paused = !ui.paused; $('#bPause').textContent = ui.paused ? 'Resume' : 'Pause';
};
$('#bSpeed').onclick = () => { speed = speed % 3 + 1; $('#bSpeed').textContent = speed + 'x'; };
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play' && !ui.paused) $('#bPause').click();
});

canvas.addEventListener('pointerdown', e => {
  if (state !== 'play') return;
  e.preventDefault();
  const { x, y } = renderer.toWorld(e.clientX, e.clientY, game.cave);
  const t = game.towerAt(x, y, 20);
  if (t) { ui.selTower = t; ui.selPoint = null; }
  else if (game.canPlace(x, y)) { ui.selPoint = { x, y }; ui.selTower = null; }
  else { ui.selPoint = ui.selTower = null; }
});

panel.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled || state !== 'play') return;
  const act = el.dataset.act;
  if (act === 'build' && ui.selPoint) {
    const t = game.build(el.dataset.type, ui.selPoint.x, ui.selPoint.y);
    if (t) { ui.selPoint = null; ui.selTower = t; }
  } else if (act === 'up' && ui.selTower) game.upgrade(ui.selTower);
  else if (act === 'sell' && ui.selTower) { game.sell(ui.selTower); ui.selTower = null; }
  else if (act === 'mode' && ui.selTower) ui.selTower.mode = (ui.selTower.mode + 1) % TARGET_MODES.length;
  lastPanel = ''; // force refresh
});

// ---------- HUD / panel ----------
const cache = {};
function setText(id, v) { if (cache[id] !== v) { cache[id] = v; $(id).textContent = v; } }
let lastPanel = '';
function panelHTML() {
  if (ui.selPoint) {
    return TOWER_ORDER.map(type => {
      const d = TOWERS[type], cost = game.towerCost(type), locked = !game.isUnlocked(type), dim = game.gold < cost;
      return `<button class="tcard ${dim && !locked ? 'dim' : ''}" data-act="build" data-type="${type}" ${locked || dim ? 'disabled' : ''}>` +
        `<i class="dot" style="border-color:${d.color}"></i><span class="nm">${d.name}</span>` +
        (locked ? `<small>Needs research</small>` : `<span class="cs">${cost}</span>`) + `</button>`;
    }).join('');
  }
  const t = ui.selTower;
  if (t) {
    const d = TOWERS[t.type], up = game.nextUpgradeCost(t);
    const stat = t.type === 'frost' ? `Slow ${Math.round(t.slow * 100)}%` : `Damage ${t.dmg.toFixed(0)}`;
    return `<div class="info"><b>${d.name} &middot; Level ${t.lvl}${t.lvl >= MAX_LEVEL ? ' (max)' : ''}</b>` +
      `<span>${stat} &middot; ${t.rate.toFixed(1)}/s &middot; Range ${t.range.toFixed(0)}</span></div>` +
      `<button class="abtn ${up !== null && game.gold < up ? 'dim' : ''}" data-act="up" ${up === null || game.gold < up ? 'disabled' : ''}>` +
      (up === null ? 'Maxed' : `Upgrade<b>${up}</b>`) + `</button>` +
      `<button class="abtn" data-act="mode" ${t.type === 'frost' ? 'disabled' : ''}>Target<b>${TARGET_MODES[t.mode]}</b></button>` +
      `<button class="abtn" data-act="sell">Sell<b>+${game.sellValue(t)}</b></button>`;
  }
  return `<div class="hint">Tap anywhere in the cave to place a tower, or tap a tower to upgrade it.</div>`;
}
function updateHud() {
  setText('#hGold', String(Math.floor(game.gold)));
  setText('#hLives', String(game.lives));
  setText('#hWave', String(game.wave));
  setText('#hAlive', String(game.n));
  const b = $('#bWave');
  const label = game.spawning ? `Wave ${game.wave} in progress`
    : `Start wave ${game.wave + 1}  (${Math.ceil(game.countdown)}s, +${Math.ceil(game.countdown)} gold)`;
  if (cache.wave !== label) { cache.wave = label; b.textContent = label; }
  b.disabled = game.spawning;
  // keep the panel on the opposite half of the screen from whatever is selected (sim x = screen vertical)
  const focus = ui.selPoint || ui.selTower;
  const pos = focus && focus.x > game.W / 2 ? 'top' : 'bottom';
  if (panel.className !== pos) panel.className = pos;
  const html = panelHTML();
  if (html !== lastPanel) { lastPanel = html; panel.innerHTML = html; }
}

// ---------- main loop ----------
const STEP = 1 / 60;
let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!game) return;
  if (state === 'play' && !ui.paused) {
    acc += dt * speed;
    let steps = 0;
    while (acc >= STEP && steps < 12) { game.update(STEP); acc -= STEP; steps++; }
    if (steps === 12) acc = 0;
    for (const ev of game.events) if (ev === 'leak' && navigator.vibrate) navigator.vibrate(30);
    game.events.length = 0;
    if (ui.selTower && !game.towers.includes(ui.selTower)) ui.selTower = null;
    if (game.over) endRun();
  }
  updateHud();
  renderer.draw(game, ui);
}
refreshMenu();
layout();
requestAnimationFrame(frame);
window.__tod = { get game() { return game; } }; // debug/test hook

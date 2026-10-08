// Run: node test/sim.test.mjs
import assert from 'node:assert/strict';
import { Game } from '../js/sim.js';
import { computeMods } from '../js/meta.js';
import { COLS, ROWS, PATH_CELLS, TOWERS, waveCount, waveList, PATH_LEN } from '../js/data.js';

const DT = 1 / 60;

// --- basic sanity
assert.equal(waveList(50).length, 300);
assert.ok(waveList(10).includes(3), 'boss on wave 10');
assert.ok(PATH_LEN > 1000);
{
  const g = new Game(computeMods({}));
  assert.ok(!g.build('frost', 0, 0), 'frost locked');
  assert.ok(!g.build('arrow', 1, 1), 'cannot build on path');
  const t = g.build('arrow', 0, 0);
  assert.ok(t && g.gold === 50);
  assert.ok(g.sell(t) && g.gold === 50 + 35);
}

// --- greedy bot: places by path adjacency, upgrades when it can
function candidates() {
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (PATH_CELLS[r * COLS + c]) continue;
    let s = 0;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && PATH_CELLS[rr * COLS + cc]) s += 3 - Math.max(Math.abs(dr), Math.abs(dc)) * 0.8;
    }
    out.push({ c, r, s });
  }
  return out.sort((a, b) => b.s - a.s);
}
const CAND = candidates();
function botStep(g) {
  const types = ['arrow', 'cannon', 'arrow', 'frost', 'cannon', 'tesla'].filter(t => g.isUnlocked(t));
  // upgrade cheapest tower first once enough towers are down
  const want = Math.min(CAND.length, 6 + Math.floor(g.wave * 1.2));
  if (g.towers.length < want) {
    const type = types[g.towers.length % types.length];
    const spot = CAND.find(p => g.canPlace(p.c, p.r));
    if (spot) g.build(type, spot.c, spot.r);
  } else {
    const t = g.towers.filter(t => g.nextUpgradeCost(t) !== null).sort((a, b) => g.nextUpgradeCost(a) - g.nextUpgradeCost(b))[0];
    if (t) g.upgrade(t);
  }
}
function run(levels, label, maxWave = 120) {
  const g = new Game(computeMods(levels), 42);
  let peak = 0, steps = 0, ms = 0;
  while (!g.over && g.wave < maxWave) {
    if (steps % 30 === 0) { botStep(g); if (!g.spawning && g.n === 0) g.skipCountdown(); }
    const t0 = performance.now();
    g.update(DT);
    ms += performance.now() - t0;
    peak = Math.max(peak, g.n); steps++;
  }
  console.log(`${label.padEnd(18)} wave ${String(g.wave).padStart(3)}  kills ${String(g.kills).padStart(5)}  towers ${String(g.towers.length).padStart(2)}  shards ${String(g.shards()).padStart(4)}  peakEnemies ${peak}  avg update ${(ms / steps).toFixed(3)} ms`);
  return { g, peak, avg: ms / steps };
}
const base = run({}, 'no tech');
const mid = run({ purse: 3, bounty: 3, dmg: 4, rate: 3, range: 2, frost: 1, lives: 3 }, 'mid tech');
const high = run({ purse: 5, bounty: 5, interest: 3, dmg: 5, rate: 5, crit: 3, range: 4, frost: 1, tesla: 1, splash: 4, lives: 5, revive: 1 }, 'full tech');

// --- worst-case perf: 300 goblins alive at once, many towers, no tech
{
  const g = new Game(computeMods({ frost: 1, tesla: 1 }), 7);
  g.gold = 1e9; g.lives = 1e9;
  let k = 0; const types = ['arrow', 'cannon', 'frost', 'tesla'];
  for (const p of CAND) { const t = g.build(types[k++ % 4], p.c, p.r); if (t) { while (g.upgrade(t)); } }
  g.wave = 40; g.waveHpNow = 1e9;           // un-killable so they stay on the field
  for (let i = 0; i < 300; i++) g.spawn(i % 3);
  for (let i = 0; i < 300; i++) { g.dist[i] = (i / 300) * 700; }
  const t0 = performance.now(); const N = 600;
  for (let i = 0; i < N; i++) { g.hp.fill(1e9, 0, g.n); g.update(DT); }
  const avg = (performance.now() - t0) / N;
  console.log(`worst case: ${g.towers.length} lvl5 towers, ${g.n} goblins -> ${avg.toFixed(3)} ms / tick (budget at 60Hz: 16.7 ms)`);
  assert.ok(avg < 4, 'sim should be far below frame budget');
}
assert.ok(base.g.wave >= 3, 'game is not instantly lost');
console.log('ok');

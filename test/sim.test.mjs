// Run: node test/sim.test.mjs
import assert from 'node:assert/strict';
import { Game } from '../js/sim.js';
import { BallWorld, buildCave, Cave, validateCave, LEAK_Y } from '../js/physics.js';
import { computeMods } from '../js/meta.js';
import { W, H, GOBLINS, waveList } from '../js/data.js';

const DT = 1 / 60;

// --- data / cave sanity
assert.equal(waveList(50).length, 300);
assert.ok(waveList(10).includes(3), 'boss on wave 10');
{
  const cave = buildCave(1);
  assert.ok(cave.validation.ok, 'a valid cave is found');
  assert.ok(cave.rocks.length >= 8, 'cave has rocks');
  let ok = 0; for (let s = 1; s <= 20; s++) if (validateCave(new Cave(s)).ok) ok++;
  console.log(`cave generator: ${ok}/20 raw seeds pass the drop test (failures are rerolled), avg transit ${cave.validation.avgTime.toFixed(1)} s`);
  assert.ok(ok >= 8);
}
// --- physics: ball rests on floor-like contact & collisions conserve separation
{
  const cave = buildCave(3), w = new BallWorld(cave, 8);
  w.add(100, 0, 6, 1); w.add(100.5, 0, 6, 1);
  for (let i = 0; i < 30; i++) w.step(DT);
  assert.ok(Math.hypot(w.x[0] - w.x[1], w.y[0] - w.y[1]) > 11, 'overlapping balls are pushed apart');
}
// --- building
{
  const g = new Game(computeMods({}), 5);
  assert.ok(!g.build('frost', 100, 100), 'frost locked');
  assert.ok(!g.build('arrow', -5, 100), 'outside map');
  const t = g.build('arrow', 100, 100);
  assert.ok(t && g.gold === 210 - 100);
  assert.ok(!g.build('arrow', 110, 105), 'towers cannot overlap');
  assert.equal(g.towerCost('arrow'), 107, 'price creeps up per owned tower');
  assert.ok(g.sell(t) && g.gold === 110 + 70);
}

// --- greedy bot with free placement: puts towers where balls spend the most time
const OPENING = [[70, 290], [290, 290], [180, 370], [70, 420], [290, 420], [180, 210], [70, 180], [290, 180]];
function makeBot() {
  const heat = new Float32Array(Math.ceil(W / 30) * Math.ceil(H / 30));
  const cols = Math.ceil(W / 30);
  for (let r = 4; r < 15; r++) for (let c = 0; c < cols; c++) heat[r * cols + c] = 0.5; // prior: uniform over the cave body
  return {
    sample(g) { for (let i = 0; i < g.n; i++) { const c = Math.floor(g.x[i] / 30), r = Math.floor(g.y[i] / 30); if (r >= 0 && r < Math.ceil(H / 30)) heat[r * cols + c]++; } },
    step(g) {
      const types = ['arrow', 'cannon', 'arrow', 'frost', 'cannon', 'tesla'].filter(t => g.isUnlocked(t));
      const want = 4 + Math.floor(g.wave * 0.8);
      if (g.towers.length < want) {
        // prefer the rotation's next type, but never sit on gold: fall back to anything affordable
        const rot = Array.from({ length: types.length }, (_, k) => types[(g.towers.length + k) % types.length]);
        const type = rot.find(t => g.gold >= g.towerCost(t));
        if (!type) return;
        const book = OPENING.find(([x, y]) => g.canPlace(x, y));
        if (book && g.towers.length < OPENING.length) { g.build(type, book[0], book[1]); return; }
        // best free cell by heat (smoothed over neighbours), restricted to the playfield
        let best = null, bv = -1;
        const rows = Math.ceil(H / 30);
        for (let r = 1; r < rows - 1; r++) for (let c = 0; c < cols; c++) {
          const x = c * 30 + 15, y = r * 30 + 15;
          if (!g.canPlace(x, y)) continue;
          let v = 0; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) v += heat[rr * cols + cc]; }
          v += (r * 0.05) + g.towers.length * 0; // slight tie-break toward the castle
          if (v > bv) { bv = v; best = [x, y]; }
        }
        if (best) g.build(type, best[0], best[1]);
      } else {
        const t = g.towers.filter(t => g.nextUpgradeCost(t) !== null).sort((a, b) => g.nextUpgradeCost(a) - g.nextUpgradeCost(b))[0];
        if (t) g.upgrade(t);
      }
    },
  };
}
function run(levels, label, maxWave = 120, seed = 42) {
  const g = new Game(computeMods(levels), seed), bot = makeBot();
  let peak = 0, steps = 0, ms = 0, worst = 0;
  while (!g.over && g.wave < maxWave) {
    if (steps % 30 === 0) { bot.step(g); if (!g.spawning && g.n === 0) g.skipCountdown(); }
    if (steps % 10 === 0) bot.sample(g);
    const t0 = performance.now();
    g.update(DT);
    const d = performance.now() - t0; ms += d; worst = Math.max(worst, d);
    peak = Math.max(peak, g.n); steps++;
  }
  console.log(`${label.padEnd(10)} wave ${String(g.wave).padStart(3)}  kills ${String(g.kills).padStart(5)}  towers ${String(g.towers.length).padStart(2)}  shards ${String(g.shards()).padStart(4)}  peak balls ${String(peak).padStart(3)}  avg tick ${(ms / steps).toFixed(3)} ms  worst ${worst.toFixed(2)} ms`);
  return { g, peak, worst };
}
const TECH_SETS = [
  ['no tech', {}],
  ['mid tech', { purse: 3, bounty: 3, dmg: 4, rate: 3, range: 2, frost: 1, lives: 3 }],
  ['full tech', { purse: 5, bounty: 5, interest: 3, dmg: 5, rate: 5, crit: 3, range: 4, frost: 1, tesla: 1, splash: 4, lives: 5, revive: 1 }],
];
let base;
for (const [label, lv] of TECH_SETS) {
  const waves = [];
  for (const seed of [42, 7, 99, 123]) { const r = run(lv, `${label} #${seed}`, 120, seed); waves.push(r.g.wave); if (!base) base = r; }
  console.log(`  -> ${label}: mean wave ${(waves.reduce((a, b) => a + b, 0) / waves.length).toFixed(1)} (${waves.join(', ')})`);
}

// --- worst-case perf: 300 balls dropped as one dense blob into a cave, many max-level towers
{
  const g = new Game(computeMods({ frost: 1, tesla: 1 }), 7);
  g.gold = 1e12; g.lives = 1e12;
  const types = ['arrow', 'cannon', 'frost', 'tesla']; let k = 0;
  for (let y = 80; y < 470; y += 40) for (let x = 30; x < 340; x += 45) { const t = g.build(types[k++ % 4], x, y); if (t) while (g.upgrade(t)); }
  g.waveHpNow = 1e9; g.wave = 40;
  for (let i = 0; i < 300; i++) g.spawn(i % 3), g.y[i] = -6 - Math.floor(i / 23) * 13, g.x[i] = 12 + (i % 23) * 14.5;
  let ms = 0, worst = 0; const N = 900;
  for (let i = 0; i < N; i++) { g.hp.fill(1e9, 0, g.n); const t0 = performance.now(); g.update(DT); const d = performance.now() - t0; ms += d; worst = Math.max(worst, d); }
  console.log(`worst case: ${g.towers.length} lvl5 towers, ${g.n} balls (dense) -> avg ${(ms / N).toFixed(3)} ms, worst ${worst.toFixed(2)} ms per tick (budget at 60 Hz: 16.7 ms)`);
  assert.ok(ms / N < 4, 'sim should be well below frame budget');
}
assert.ok(base.g.wave >= 3, 'game is not instantly lost');
console.log('ok');

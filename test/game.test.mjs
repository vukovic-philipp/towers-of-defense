import test from 'node:test';
import assert from 'node:assert/strict';
import { buildField, makeBuildCheck, FW, FH, CELL, ROCKS } from '../js/map.js';
import { TOWERS, TREES, NODES, ENEMIES, waveSpec, choices, nodeCost, towerStats, WORLD_W } from '../js/data.js';
import { RESEARCH, BRANCHES, loadMeta, saveMeta, buyResearch, status, level, effects, shardsFor, researchNode } from '../js/meta.js';
import { SLIDERS, PERKS, perksFor, defaultPts, designBase, designCost, discount, sanitize, maxPoints, usedPoints } from '../js/design.js';
import { COMPUTE, RENDER } from '../js/shaders.js';

const map = buildField();
const build = makeBuildCheck(map);

test('every free spawn row can walk the flow field to the gate', () => {
  assert.ok(map.spawnY1 - map.spawnY0 > 400, 'spawn span is wide');
  for (let y = map.spawnY0; y <= map.spawnY1; y += 12) {
    let x = 8, yy = y, steps = 0;
    while (x < WORLD_W - 8 && steps < 4000) {
      const i = Math.floor(yy / CELL) * FW + Math.floor(x / CELL);
      assert.ok(map.field[i * 4 + 2] > 0, `walked into terrain at ${x | 0},${yy | 0}`);
      x += map.field[i * 4] * 2; yy += map.field[i * 4 + 1] * 2; steps++;
    }
    assert.ok(x >= WORLD_W - 8, `start y=${y} never reached the gate`);
  }
});

test('flow field has unit vectors in free space and the sdf is signed', () => {
  let free = 0;
  for (let i = 0; i < FW * FH; i++) {
    if (map.field[i * 4 + 2] > 8) {
      free++;
      const m = Math.hypot(map.field[i * 4], map.field[i * 4 + 1]);
      assert.ok(Math.abs(m - 1) < 1e-3 || m === 0);
    }
  }
  assert.ok(free > 30000);
  assert.ok(map.sdf.some((v) => v < 0) && map.sdf.some((v) => v > 0));
});

test('each rock has room to build and walls are not buildable', () => {
  ROCKS.forEach((poly, idx) => {
    const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
    let ok = false;
    for (let dy = -60; dy <= 60 && !ok; dy += 6) for (let dx = -60; dx <= 60 && !ok; dx += 6) ok = build.canBuild(cx + dx, cy + dy);
    assert.ok(ok, `rock ${idx} has no buildable spot`);
  });
  assert.equal(build.canBuild(100, 30), false);
  assert.equal(build.canBuild(800, 20), false);
});

const MOD_KEYS = new Set(['range', 'dmg', 'rate', 'radius', 'ignite', 'flight', 'splash', 'pierce', 'pct', 'slow', 'spread', 'ramp']);

test('every tower has a well-formed upgrade tree', () => {
  assert.equal(TOWERS.length, 4);
  assert.equal(TREES.length, 4);
  TREES.forEach((tree, kind) => {
    assert.equal(tree.filter((n) => n.tier === 1).length, 2, 'two paths in tier 1');
    for (const n of tree.filter((x) => x.tier === 1)) {
      assert.equal(tree.filter((c) => c.parent === n.id).length, 2, `${n.id} offers two specialties`);
    }
    const ids = new Set();
    for (const n of [...tree, NODES[kind].master]) {
      assert.ok(!ids.has(n.id), `duplicate id ${n.id}`); ids.add(n.id);
      for (const k of [...Object.keys(n.mods.mul), ...Object.keys(n.mods.set)]) assert.ok(MOD_KEYS.has(k), `${n.id}: unknown stat ${k}`);
      assert.ok(n.name && n.desc);
    }
  });
});

test('upgrade choices are mutually exclusive and walk down the tree', () => {
  TREES.forEach((tree, kind) => {
    const first = choices(kind, []);
    assert.equal(first.length, 2);
    for (const a of first) {
      const second = choices(kind, [a.id]);
      assert.equal(second.length, 2);
      assert.ok(second.every((n) => n.parent === a.id));
      const other = first.find((n) => n !== a);
      // nothing under the path not taken is reachable
      const reachable = new Set(second.map((n) => n.id));
      for (const n of tree.filter((x) => x.parent === other.id)) assert.ok(!reachable.has(n.id));
      for (const b of second) {
        assert.deepEqual(choices(kind, [a.id, b.id]).map((n) => n.id), ['master']);
        assert.deepEqual(choices(kind, [a.id, b.id, 'master']), []);
      }
    }
  });
});

test('stats are finite, every full path is positive-sum, and costs grow by tier', () => {
  TREES.forEach((tree, kind) => {
    const base = towerStats(kind, []);
    for (const a of choices(kind, [])) for (const b of choices(kind, [a.id])) {
      const st = towerStats(kind, [a.id, b.id, 'master']);
      for (const v of Object.values(st)) assert.ok(Number.isFinite(v) && v >= 0);
      assert.ok(st.dmg * st.rate > base.dmg * base.rate * 0.9, `${kind}/${a.id}/${b.id} is weaker than base`);
      const v = [a.id, b.id, 'master'].reduce((sum, id) => sum + nodeCost(kind, NODES[kind][id]), TOWERS[kind].cost);
      assert.ok(v > TOWERS[kind].cost * 4);
    }
    const [n1] = choices(kind, []);
    assert.ok(nodeCost(kind, NODES[kind].master) > nodeCost(kind, n1));
  });
});

test('mortar is a real option: a single shell on a clump out-damages a gun shot', () => {
  const mortar = towerStats(3, []), gun = towerStats(0, []);
  assert.ok(mortar.dmg * mortar.rate > gun.dmg * gun.rate * 0.7);
  assert.ok(mortar.radius >= 50);
});

test('waves grow into the hundreds, bosses every tenth wave, new enemy types phase in', () => {
  const total = (n) => waveSpec(n).counts.reduce((a, b) => a + b, 0);
  for (let n = 2; n <= 40; n++) assert.ok(total(n) >= total(n - 1) - 1, `wave ${n} shrank`);
  assert.ok(total(10) >= 150 && total(20) >= 400);
  assert.equal(waveSpec(9).counts[4], 0);
  assert.equal(waveSpec(10).counts[4], 1);
  assert.equal(waveSpec(20).counts[4], 2);
  assert.deepEqual(waveSpec(1).counts.slice(2), new Array(ENEMIES.length - 2).fill(0), 'wave 1 is swarmers only');
  assert.ok(total(40) < 4096 / 2, 'one wave stays well under the enemy buffer size');
  assert.equal(ENEMIES.length, 11);
  const seen = new Set();
  for (let n = 1; n <= 25; n++) waveSpec(n).counts.forEach((c, k) => { if (c > 0) seen.add(k); });
  for (let k = 1; k < ENEMIES.length; k++) assert.ok(seen.has(k), `${ENEMIES[k].name} never appears by wave 25`);
});

test('gold is scarce: a full early wave pays far less than one cheap tower per wave of enemies', () => {
  // expected gold from killing every enemy of a wave (before research)
  const gold = (n) => { const w = waveSpec(n); return w.counts.reduce((a, c, k) => a + (k ? c * ENEMIES[k].reward : 0), 0) * w.goldMult; };
  assert.ok(gold(1) < 25 && gold(5) < 150 && gold(10) < 600, `${gold(1)} ${gold(5)} ${gold(10)}`);
});

test('research nodes are well formed and purchasable in order', () => {
  const ids = new Set();
  for (const n of RESEARCH) {
    assert.ok(!ids.has(n.id)); ids.add(n.id);
    assert.equal(n.cost.length, n.max); assert.ok(n.branch >= 0 && n.branch < BRANCHES.length);
    if (n.req) { assert.ok(researchNode(n.req[0]), `${n.id} requires unknown ${n.req[0]}`); assert.ok(n.req[1] <= researchNode(n.req[0]).max); }
  }
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  const m = loadMeta(mem);
  assert.equal(m.shards, 0);
  assert.equal(status(m, 'eco_start'), 'poor');
  assert.equal(status(m, 'eco_bounty'), 'locked');
  m.shards = 100;
  assert.ok(buyResearch(m, 'eco_start'));
  assert.equal(level(m, 'eco_start'), 1); assert.equal(m.shards, 94);
  assert.equal(buyResearch(m, 'eco_wave'), false, 'locked until its requirement is met');
  assert.ok(buyResearch(m, 'eco_bounty'));
  saveMeta(m, mem);
  const back = loadMeta(mem);
  assert.equal(level(back, 'eco_bounty'), 1);
  assert.equal(effects(back).startGold, 30);
  assert.ok(Math.abs(effects(back).bounty - 0.08) < 1e-9);
  assert.ok(!effects(back).perks.has('pierce'));
  assert.equal(loadMeta({ getItem() { return '{not json'; } }).shards, 0, 'corrupt storage falls back to empty');
});

test('research points scale with how far a run got', () => {
  assert.ok(shardsFor(1, 10) >= 1);
  assert.ok(shardsFor(10, 300) > shardsFor(5, 100));
  assert.ok(shardsFor(20, 1500) > shardsFor(10, 300) * 1.5);
});

test('workshop: default designs match the standard towers, price follows power, budget is enforced', () => {
  for (let k = 0; k < 4; k++) {
    const pts = defaultPts(k);
    assert.deepEqual(Object.keys(pts), Object.keys(SLIDERS[k]));
    assert.equal(designCost(k, pts, []), TOWERS[k].cost, 'default design costs the base price');
    const b = designBase(k, pts, []);
    for (const key of ['range', 'dmg', 'rate']) assert.ok(Math.abs(b[key] - TOWERS[k].base[key]) < 1e-9);
    assert.ok(Math.abs(b.radius - TOWERS[k].base.radius) < 1e-9);
    const strong = { ...pts, dmg: 6 };
    assert.ok(designCost(k, strong, []) > designCost(k, pts, []));
    assert.ok(designBase(k, strong, []).dmg > b.dmg);
    assert.ok(usedPoints(pts) <= maxPoints(k, 0));
    for (const id of perksFor(k)) {
      const withPerk = designBase(k, pts, [id]);
      assert.ok(Object.entries(PERKS[id].set).every(([s, v]) => withPerk[s] === v));
      assert.ok(designCost(k, pts, [id]) > TOWERS[k].cost);
    }
  }
  assert.ok(designBase(2, { dmg: 2, range: 2, radius: 6, ignite: 2 }, []).radius < 0.86, 'wider cone means a smaller cosine');
  assert.ok(designBase(2, { dmg: 2, range: 2, radius: 10, ignite: 2 }, []).radius >= 0.3, 'cone stays bounded');
  assert.equal(discount(100, 0.04), 95);
  assert.ok(discount(5, 0.5) >= 5);
});

test('workshop: stale or hostile saved designs are sanitised', () => {
  const d = sanitize({ kind: 1, name: 'x', pts: { dmg: 99, range: -4, bogus: 3 }, perks: ['ramp', 'ramp', 'splash', 'nope', 'pierce'] });
  assert.deepEqual(Object.keys(d.pts), Object.keys(SLIDERS[1]));
  assert.equal(d.pts.dmg, 10); assert.equal(d.pts.range, 0); assert.equal(d.pts.radius, 2);
  assert.deepEqual(d.perks, ['ramp'], 'only perks valid for this behaviour, no duplicates');
});

test('shader source has no unresolved template values', () => {
  for (const src of [COMPUTE, RENDER]) {
    assert.ok(!/undefined|NaN|\$\{/.test(src));
    assert.ok(src.includes('@compute') || src.includes('@vertex'));
  }
});

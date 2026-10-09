import test from 'node:test';
import assert from 'node:assert/strict';
import { buildField, makeBuildCheck, FW, FH, CELL, ROCKS } from '../js/map.js';
import { TOWERS, TREES, NODES, ENEMIES, waveSpec, towerValue, choices, nodeCost, towerStats, WORLD_W } from '../js/data.js';
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
      const v = towerValue({ kind, path: [a.id, b.id, 'master'] });
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

test('waves grow into the hundreds and bosses arrive every tenth wave', () => {
  const total = (n) => waveSpec(n).counts.reduce((a, b) => a + b, 0);
  for (let n = 2; n <= 40; n++) assert.ok(total(n) >= total(n - 1), `wave ${n} shrank`);
  assert.ok(total(10) >= 150 && total(20) >= 400);
  assert.equal(waveSpec(9).counts[4], 0);
  assert.equal(waveSpec(10).counts[4], 1);
  assert.equal(waveSpec(20).counts[4], 2);
  assert.equal(waveSpec(1).counts[2], 0, 'wave 1 is swarmers only');
  assert.ok(total(40) < 4096 / 2, 'one wave stays well under the enemy buffer size');
});

test('shader source has no unresolved template values', () => {
  for (const src of [COMPUTE, RENDER]) {
    assert.ok(!/undefined|NaN|\$\{/.test(src));
    assert.ok(src.includes('@compute') || src.includes('@vertex'));
  }
  assert.equal(ENEMIES.length, 5);
});

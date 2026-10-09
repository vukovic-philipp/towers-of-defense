import test from 'node:test';
import assert from 'node:assert/strict';
import { buildField, makeBuildCheck, FW, FH, CELL, ROCKS } from '../js/map.js';
import { TOWERS, ENEMIES, waveSpec, towerValue, MAX_LEVEL, WORLD_W } from '../js/data.js';
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

test('tower tables are complete and upgrades strictly improve', () => {
  assert.equal(TOWERS.length, 4);
  for (const t of TOWERS) {
    assert.equal(t.upgrade.length, MAX_LEVEL);
    for (const k of ['range', 'dmg', 'rate', 'radius']) assert.equal(t[k].length, MAX_LEVEL + 1);
    for (let l = 1; l <= MAX_LEVEL; l++) assert.ok(t.dmg[l] > t.dmg[l - 1] && t.range[l] >= t.range[l - 1]);
    assert.ok(towerValue({ kind: TOWERS.indexOf(t), level: MAX_LEVEL }) > t.cost);
  }
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

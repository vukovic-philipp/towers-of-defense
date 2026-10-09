import test from 'node:test';
import assert from 'node:assert/strict';
import { buildField, makeBuildCheck, FW, FH, CELL, ROCKS, SKETCH_LAYOUT } from '../js/map.js';
import { TOWERS, TREES, NODES, ENEMIES, waveSpec, choices, nodeCost, towerStats, WORLD_W, WORLD_H, MAX_ENEMIES } from '../js/data.js';
import { generateMap, analyzeMap, drawLayout, placeOre, sketchMap, mulberry32 } from '../js/mapgen.js';
import { RESOURCES, AMMO, DRILL, newStock, patchAt, canDrill, drillAt, income, mine, billAmmo, updateStarved, drillRate, drillInvested } from '../js/economy.js';
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

const MOD_KEYS = new Set(['range', 'dmg', 'rate', 'radius', 'ignite', 'flight', 'splash', 'pierce', 'pct', 'slow', 'spread', 'ramp', 'ap', 'exec', 'crit']);

test('every tower has a well-formed upgrade tree', () => {
  assert.equal(TOWERS.length, 4);
  assert.equal(TREES.length, 4);
  TREES.forEach((tree, kind) => {
    assert.equal(tree.filter((n) => n.tier === 1).length, 2, 'two paths in tier 1');
    for (const n of tree.filter((x) => x.tier === 1)) {
      assert.equal(tree.filter((c) => c.parent === n.id).length, 2, `${n.id} offers two specialties`);
    }
    for (const n of tree.filter((x) => x.tier === 2)) {
      assert.equal(tree.filter((c) => c.tier === 4 && c.parent === n.id).length, 1, `${n.id} has one mastery`);
    }
    assert.equal(tree.filter((n) => n.tier === 5).length, 2, 'two ultimates');
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
        assert.deepEqual(choices(kind, [a.id, b.id, 'master']), [], 'tiers 4 and 5 are locked until researched');
        const m = choices(kind, [a.id, b.id, 'master'], 4);
        assert.equal(m.length, 1); assert.equal(m[0].parent, b.id, 'the mastery belongs to the chosen specialty');
        assert.equal(choices(kind, [a.id, b.id, 'master', m[0].id], 4).length, 0);
        const u = choices(kind, [a.id, b.id, 'master', m[0].id], 5);
        assert.equal(u.length, 2);
        assert.deepEqual(choices(kind, [a.id, b.id, 'master', m[0].id, u[0].id], 5), []);
      }
    }
  });
});

test('stats are finite, every full path is positive-sum, and costs grow by tier', () => {
  TREES.forEach((tree, kind) => {
    const base = towerStats(kind, []);
    for (const a of choices(kind, [])) for (const b of choices(kind, [a.id])) {
      const m4 = choices(kind, [a.id, b.id, 'master'], 4)[0];
      for (const u of choices(kind, [a.id, b.id, 'master', m4.id], 5)) {
        const full = towerStats(kind, [a.id, b.id, 'master', m4.id, u.id]);
        for (const v of Object.values(full)) assert.ok(Number.isFinite(v) && v >= 0, `${u.id} stats`);
        const prev = towerStats(kind, [a.id, b.id, 'master']);
        assert.ok(full.dmg * full.rate >= prev.dmg * prev.rate * 0.95, `${m4.id}+${u.id} must not be a downgrade`);
        assert.ok(nodeCost(kind, u) > nodeCost(kind, m4) && nodeCost(kind, m4) > nodeCost(kind, NODES[kind].master));
      }
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
  for (const n of [60, 100, 165, 400]) assert.ok(total(n) < MAX_ENEMIES / 2, `wave ${n} is capped (${total(n)})`);
  assert.equal(ENEMIES.length, 15);
  const seen = new Set();
  for (let n = 1; n <= 100; n++) waveSpec(n).counts.forEach((c, k) => { if (c > 0) seen.add(k); });
  for (let k = 1; k < ENEMIES.length; k++) assert.ok(seen.has(k), `${ENEMIES[k].name} never appears by wave 100`);
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

test('heavy enemies are heavier than everything before them and arrive late', () => {
  const heavy = ENEMIES.slice(11);
  assert.equal(heavy.length, 4);
  const before = ENEMIES.slice(1, 11).filter((e) => e.name !== 'Titan');
  for (const e of heavy) assert.ok(e.hp > Math.max(...before.map((b) => b.hp)) * 2, `${e.name} hp`);
  assert.ok(ENEMIES[11].armor >= 20 && ENEMIES[13].armor >= 40 && ENEMIES[14].armor >= 55, 'armor ladder');
  assert.deepEqual([11, 12, 13, 14].map((k) => waveSpec(15).counts[k]), [0, 0, 0, 0]);
  assert.ok(waveSpec(22).counts[11] > 0 && waveSpec(28).counts[12] > 0);
  assert.equal(waveSpec(35).counts[13], 1); assert.equal(waveSpec(45).counts[13], 2);
  assert.equal(waveSpec(50).counts[14], 1); assert.equal(waveSpec(75).counts[14], 2);
  assert.equal(waveSpec(36).counts[13], 0);
});

test('shader tables cover every enemy kind and the new tower fields', () => {
  assert.ok(COMPUTE.includes(`array<f32,${ENEMIES.length}>`));
  assert.ok(COMPUTE.includes('array<vec4<u32>, 4>'), 'room for 16 spawn counts');
  assert.ok(COMPUTE.includes('ap: f32, exec: f32, crit: f32'));
  assert.ok(COMPUTE.includes('rallied'));
});

test('research opens tiers 4 and 5 per weapon, and logistics scale the economy', () => {
  const m = loadMeta({ getItem() { return null; } });
  assert.deepEqual(effects(m).towerTier, [3, 3, 3, 3]);
  m.shards = 1000;
  assert.equal(status(m, 'mast_gun'), 'locked', 'masteries need Hardened Ammo first');
  assert.ok(buyResearch(m, 'def_lives')); assert.ok(buyResearch(m, 'def_dmg'));
  assert.equal(buyResearch(m, 'ult_gun'), false, 'ultimates need the mastery first');
  assert.ok(buyResearch(m, 'mast_gun'));
  assert.deepEqual(effects(m).towerTier, [4, 3, 3, 3]);
  assert.ok(buyResearch(m, 'ult_gun'));
  assert.deepEqual(effects(m).towerTier, [5, 3, 3, 3]);
  const base = effects(m);
  assert.equal(base.stockCap, 400); assert.equal(base.drillLevels, 2); assert.equal(base.ammoUse, 1);
  for (const id of ['log_start', 'log_drill', 'log_stock', 'log_eff']) assert.ok(buyResearch(m, id), id);
  const fx = effects(m);
  assert.ok(fx.startIron > 0 && fx.drillSpeed > 1 && fx.stockCap > 400 && fx.ammoUse < 1);
  assert.equal(fx.drillLevels, 2);
  assert.ok(buyResearch(m, 'log_drill'));
  assert.ok(buyResearch(m, 'log_deep'));
  assert.equal(effects(m).drillLevels, 3);
  for (const w of ['gun', 'laser', 'flame', 'mortar']) assert.ok(researchNode('mast_' + w) && researchNode('ult_' + w));
});

// ---------- generated maps ----------
test('random maps pass the dead-end check for many seeds', () => {
  let rerolls = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const { layout, map, attempts } = generateMap(seed * 4001);
    rerolls += attempts - 1;
    const rep = analyzeMap(map);
    assert.ok(rep.ok, `seed ${seed}: ${rep.problems.join(', ')}`);
    assert.ok(rep.orphanCells === 0 && rep.bucketCells <= 40);
    assert.ok(layout.rocks.length >= 5, 'enough rocks to build on');
    assert.ok(layout.ore.length >= 4, 'ore on the high ground');
    assert.ok(layout.ore.some((p) => p.res === 'iron') && layout.ore.some((p) => p.res === 'coal'), 'both ores');
  }
  assert.ok(rerolls < 25 * 3, 'most seeds validate without re-rolling');
});

test('random maps are reproducible from a seed', () => {
  const a = generateMap(777), b = generateMap(777), c = generateMap(778);
  assert.equal(a.seed, b.seed);
  assert.deepEqual(a.layout.rocks, b.layout.rocks);
  assert.deepEqual(a.layout.ore, b.layout.ore);
  assert.notDeepEqual(a.layout.rocks, c.layout.rocks);
});

test('generated maps are playable: every rock holds a tower, towers never fit outside rocks, ore stays on the high ground', () => {
  for (const seed of [11, 222, 3333]) {
    const { layout, map } = generateMap(seed);
    const b = makeBuildCheck(map);
    layout.rocks.forEach((poly, i) => {
      const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
      let ok = false;
      for (let dy = -70; dy <= 70 && !ok; dy += 6) for (let dx = -90; dx <= 90 && !ok; dx += 6) ok = b.canBuild(cx + dx, cy + dy);
      assert.ok(ok, `seed ${seed} rock ${i} has no buildable spot`);
    });
    assert.equal(b.canBuild(5, 5), false);
    for (const p of layout.ore) {
      const i = Math.floor(p.y / CELL) * FW + Math.floor(p.x / CELL);
      assert.ok(map.solid[i] && !map.rockId[i], 'ore sits on wall terrain');
      assert.ok(-map.sdf[i] >= 38, 'and well away from the canyon');
      assert.ok(p.x > 40 && p.x < WORLD_W - 40 && p.y > 40 && p.y < WORLD_H - 40);
    }
    const spread = layout.ore.map((p) => p.x);
    assert.ok(Math.max(...spread) - Math.min(...spread) > 500, 'patches are spread across the map');
  }
});

test('the dead-end check catches buckets and blocked canyons', () => {
  const base = drawLayout(generateMap(5).seed);
  assert.equal(analyzeMap(buildField(base)).ok, true, 'the untouched layout is fine');
  // a deep U shaped cup in mid canyon, open toward the entry: enemies drift in and the flow points back out
  const cup = [[700, 380], [960, 380], [960, 560], [700, 560], [700, 520], [900, 520], [900, 420], [700, 420]];
  const bucket = { ...base, rocks: [...base.rocks.filter((r) => !r.some(([x]) => x > 560 && x < 1100)), cup] };
  const rep = analyzeMap(buildField(bucket));
  assert.equal(rep.ok, false, 'a cup facing the entry is a bucket');
  assert.ok(rep.bucketCells > 40 || rep.problems.some((p) => /stuck/.test(p)), rep.problems.join(', '));
  // a rock wall across the whole canyon leaves nowhere to go
  const blocked = { ...base, rocks: [...base.rocks, [[800, 0], [830, 0], [830, 900], [800, 900]]] };
  assert.equal(analyzeMap(buildField(blocked)).ok, false, 'a wall across the canyon blocks the gate');
  // a 44 wide gap lets small enemies through but not a Leviathan (radius 26), so it must be rejected
  const pinch = { ...base, rocks: [...base.rocks.filter((r) => !r.some(([x]) => x > 600 && x < 900)), [[700, 0], [760, 0], [760, 428], [700, 428]], [[700, 472], [760, 472], [760, 900], [700, 900]]] };
  const pr = analyzeMap(buildField(pinch));
  assert.equal(pr.ok, false, pr.problems.join(', '));
});

test('the classic sketch map still works and has ore', () => {
  const s = sketchMap();
  assert.ok(s.layout.ore.length >= 4);
  assert.equal(s.layout.rocks, ROCKS);
  assert.ok(s.map.spawnY1 - s.map.spawnY0 > 400);
});

// ---------- mining and ammunition ----------
const FX0 = { drillSpeed: 1, stockCap: 400, ammoUse: 1, startIron: 0, startCoal: 0 };
const patches = [{ x: 300, y: 80, r: 34, res: 'iron', rich: 1.2 }, { x: 900, y: 820, r: 34, res: 'coal', rich: 1 }];

test('drills only fit on ore, keep their distance and fill up patches', () => {
  assert.equal(patchAt(patches, 300, 80), 0);
  assert.equal(patchAt(patches, 600, 400), -1);
  assert.equal(canDrill(patches, [], 600, 400).ok, false);
  assert.equal(canDrill(patches, [], 300 + 30, 80).ok, false, 'patch edge');
  assert.equal(canDrill(patches, [], 300, 80).ok, true);
  const d1 = { patch: 0, x: 300, y: 80, level: 1 };
  assert.equal(canDrill(patches, [d1], 310, 80).ok, false, 'too close');
  assert.equal(canDrill(patches, [d1], 326, 80).ok, true);
  assert.equal(drillAt([d1], 305, 84), 0);
  assert.equal(drillAt([null, d1], 400, 400), -1);
  const full = [0, 1, 2, 3].map((k) => ({ patch: 0, x: 300 + k * 30, y: 80, level: 1 }));
  assert.equal(canDrill(patches, full, 300, 100).ok, false);
});

test('drills mine into the stockpile, capped by warehouse size, faster with level and research', () => {
  const stock = newStock(FX0);
  assert.equal(stock.iron, 90);
  const drills = [{ patch: 0, x: 300, y: 80, level: 1 }, { patch: 1, x: 900, y: 820, level: 3 }];
  const inc = income(patches, drills, FX0);
  assert.ok(Math.abs(inc.iron - 0.9 * 1.2) < 1e-9 && Math.abs(inc.coal - 0.9 * 2.6) < 1e-9);
  mine(stock, patches, drills, FX0, 10);
  assert.ok(Math.abs(stock.iron - (90 + 10.8)) < 1e-6);
  mine(stock, patches, drills, { ...FX0, stockCap: 100 }, 1000);
  assert.equal(stock.iron, 100); assert.equal(stock.coal, 100);
  assert.ok(drillRate(patches[0], 2, { drillSpeed: 1.3 }) > drillRate(patches[0], 2, FX0));
  assert.ok(drillInvested(3) > drillInvested(2) && drillInvested(1) === DRILL.cost);
});

test('towers are billed for what they fire and starve when the stockpile is empty', () => {
  const towers = [{ kind: 0 }, { kind: 3 }, null, { kind: 2 }];
  const prev = new Float32Array(4), usage = new Float32Array([100, 10, 0, 20]);
  const stock = { iron: 500, coal: 500 };
  const spent = billAmmo(stock, towers, usage, prev, FX0);
  assert.ok(Math.abs(spent.iron - (100 * AMMO[0].per + 10 * AMMO[3].per)) < 1e-9);
  assert.ok(Math.abs(spent.coal - 20 * AMMO[2].per) < 1e-9);
  assert.equal(billAmmo(stock, towers, usage, prev, FX0).iron, 0, 'nothing new fired, nothing billed');
  usage[0] = 150;
  assert.ok(Math.abs(billAmmo(stock, towers, usage, prev, FX0).iron - 50 * AMMO[0].per) < 1e-9);
  usage[0] = 2; // slot reused by a fresh tower
  assert.ok(Math.abs(billAmmo(stock, towers, usage, prev, FX0).iron - 2 * AMMO[0].per) < 1e-9);
  // a sold tower's slot keeps reporting its old total until the GPU reset lands: the newcomer must not pay for it
  const slots = [null], p2 = new Float32Array(1), st2 = { iron: 100, coal: 100 };
  billAmmo(st2, [{ kind: 0 }], new Float32Array([500]), p2, FX0); st2.iron = 100;
  billAmmo(st2, slots, new Float32Array([500]), p2, FX0);        // sold, still reading 500
  billAmmo(st2, [{ kind: 0 }], new Float32Array([500]), p2, FX0); // new tower placed, stale 500
  assert.equal(st2.iron, 100, 'stale reading is free');
  billAmmo(st2, [{ kind: 0 }], new Float32Array([3]), p2, FX0);   // fresh counter
  assert.ok(Math.abs(st2.iron - (100 - 3 * AMMO[0].per)) < 1e-9);
  const thrifty = billAmmo({ iron: 9e9, coal: 9e9 }, [{ kind: 0 }], new Float32Array([100]), new Float32Array(1), { ...FX0, ammoUse: 0.5 });
  assert.ok(Math.abs(thrifty.iron - 100 * AMMO[0].per * 0.5) < 1e-9);
  const dry = { iron: 1, coal: 500 };
  billAmmo(dry, [{ kind: 3 }], new Float32Array([50]), new Float32Array(1), FX0);
  assert.equal(dry.iron, 0, 'the stockpile never goes negative');
  const starved = { iron: false, coal: false };
  assert.equal(updateStarved(starved, dry), true); assert.equal(starved.iron, true); assert.equal(starved.coal, false);
  dry.iron = 0.8; assert.equal(updateStarved(starved, dry), false, 'stays dry until a little ammo is back');
  dry.iron = 2; assert.equal(updateStarved(starved, dry), true); assert.equal(starved.iron, false);
});

test('ammunition is cheap enough that one drill keeps a couple of towers firing', () => {
  const gun = towerStats(0, []), mortar = towerStats(3, []);
  const gunBurn = gun.rate * AMMO[0].per, mortarBurn = mortar.rate * AMMO[3].per;
  assert.ok(gunBurn < 0.9 && mortarBurn < 1.2, `${gunBurn} ${mortarBurn}`);
  assert.ok(RESOURCES.iron && RESOURCES.coal && AMMO.length === TOWERS.length);
  assert.ok(DRILL.cost <= TOWERS[0].cost, 'a drill costs about one tower');
});

test('shader usage counters and ammo flag exist', () => {
  assert.ok(COMPUTE.includes('s.used += 1.0') && COMPUTE.includes('s.used += P.dt'));
  assert.ok(COMPUTE.includes('c.live == 2u'));
});

// Procedural maps: a winding canyon with rock islands to build on and ore on the high ground beside it.
// Every generated layout is run through analyzeMap(): no pockets enemies can wander into and not
// leave, no pinch points the heaviest enemy cannot squeeze through, and a fleet of simulated walkers
// has to reach the gate from every spawn row. Layouts that fail are thrown away and re-rolled.
import { WORLD_W, WORLD_H } from './data.js';
import { buildField, CELL, FW, FH, SKETCH_LAYOUT } from './map.js';

export const ORE_RADIUS = 34;
export const MAX_ENEMY_RADIUS = 26;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// smooth 1D value noise: random control points joined by cosine easing
function noise1d(rnd, spacing, lo, hi) {
  const n = Math.ceil((WORLD_W + 400) / spacing) + 2;
  const pts = Array.from({ length: n }, () => lo + (hi - lo) * rnd());
  return (x) => {
    const g = (x + 120) / spacing, i = Math.max(0, Math.min(n - 2, Math.floor(g)));
    const t = (1 - Math.cos(Math.max(0, Math.min(1, g - i)) * Math.PI)) / 2;
    return pts[i] * (1 - t) + pts[i + 1] * t;
  };
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}
function polyGap(A, B) {
  let m = Infinity;
  for (const [P, Q] of [[A, B], [B, A]]) {
    for (const [x, y] of P) for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) m = Math.min(m, segDist(x, y, Q[j][0], Q[j][1], Q[i][0], Q[i][1]));
  }
  return m;
}

function makeRock(rnd, cx, cy, R, aspect) {
  const N = 16, p1 = rnd() * 6.28, p2 = rnd() * 6.28, pts = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * 6.2832;
    const r = 1 + 0.12 * Math.sin(2 * th + p1) + 0.09 * Math.sin(3 * th + p2) + (rnd() - 0.5) * 0.08;
    pts.push([cx + Math.cos(th) * R * aspect * r, cy + Math.sin(th) * R * r]);
  }
  return pts;
}

// One candidate layout for a seed (not yet validated).
export function drawLayout(seed) {
  const rnd = mulberry32(seed);
  const center = noise1d(rnd, 300, 395, 505);
  const half = noise1d(rnd, 330, 190, 250);
  const rough = noise1d(rnd, 64, -14, 14);
  const rough2 = noise1d(rnd, 150, -14, 14);
  const top = (x) => center(x) - half(x) + rough(x) * 0.6 + rough2(x) * 0.4;
  const bottom = (x) => center(x) + half(x) + rough2(x + 90) * 0.6 + rough(x + 40) * 0.4;
  const xs = [];
  for (let x = -60; x <= 1660; x += 20) xs.push(x);
  const wall = (f, edge) => [...xs.map((x) => [x, f(x)]), [xs[xs.length - 1], edge], [xs[0], edge]];
  const walls = [wall(top, -300), wall(bottom, 1500)];

  // rock islands, spread along the canyon so every stretch has somewhere to build
  const rocks = [];
  const count = 6 + Math.floor(rnd() * 3);
  const GAP_WALL = 88, GAP_ROCK = 84;
  for (let i = 0; i < count; i++) {
    const slot = 170 + ((WORLD_W - 340) * (i + 0.5)) / count;
    for (let tries = 0; tries < 60; tries++) {
      const R = 50 + rnd() * 36, aspect = 1 + rnd() * 0.45;
      const cx = slot + (rnd() - 0.5) * 120;
      const room = half(cx) - R * 1.2 - GAP_WALL;
      if (room < 0) continue;
      const cy = center(cx) + (rnd() * 2 - 1) * room;
      const poly = makeRock(rnd, cx, cy, R, aspect);
      let ok = poly.every(([x, y]) => y - top(x) > GAP_WALL && bottom(x) - y > GAP_WALL && x > 110 && x < WORLD_W - 110);
      for (const r of rocks) if (ok && polyGap(poly, r) < GAP_ROCK) ok = false;
      if (ok) { rocks.push(poly); break; }
    }
  }
  return { name: 'Generated canyon', walls, rocks, seed };
}

// ---------- ore ----------
export function placeOre(map, seed, want = 6) {
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const patches = [];
  for (const depth of [66, 52, 40]) {
    const cand = [];
    for (let cy = 0; cy < FH; cy++) {
      for (let cx = 0; cx < FW; cx++) {
        const i = cy * FW + cx;
        if (!map.solid[i] || map.rockId[i]) continue;
        const x = (cx + 0.5) * CELL, y = (cy + 0.5) * CELL;
        if (x < 70 || x > WORLD_W - 70 || y < ORE_RADIUS + 12 || y > WORLD_H - ORE_RADIUS - 12) continue;
        if (-map.sdf[i] >= depth) cand.push([x, y]);
      }
    }
    // greedy random picks, kept apart from each other
    for (let tries = 0; tries < 400 && cand.length && patches.length < want; tries++) {
      const [x, y] = cand[Math.floor(rnd() * cand.length)];
      if (patches.some((p) => Math.hypot(p.x - x, p.y - y) < 250)) continue;
      patches.push({ x, y, r: ORE_RADIUS, res: 'iron', rich: 1 });
    }
    if (patches.length >= want) break;
  }
  // alternate the two ores, random start; richer patches are rarer
  const first = rnd() < 0.5 ? 0 : 1;
  patches.sort((a, b) => a.x - b.x);
  patches.forEach((p, i) => { p.res = (i + first) % 2 ? 'coal' : 'iron'; p.rich = Math.round((0.85 + rnd() * 0.5) * 20) / 20; });
  return patches;
}

// ---------- validation ----------
// Walks a grid-sized agent the same way the GPU does (flow field, per-agent drift, terrain push-out).
function walkAgent(map, y0, seed, radius) {
  const dt = 1 / 30, speed = 50;
  const f = map.field;
  const at = (x, y, c) => {
    const gx = Math.max(0, Math.min(FW - 1, x / CELL - 0.5)), gy = Math.max(0, Math.min(FH - 1, y / CELL - 0.5));
    const ix = Math.min(FW - 2, Math.floor(gx)), iy = Math.min(FH - 2, Math.floor(gy)), tx = gx - ix, ty = gy - iy;
    const a = (xx, yy) => f[(yy * FW + xx) * 4 + c];
    return (a(ix, iy) * (1 - tx) + a(ix + 1, iy) * tx) * (1 - ty) + (a(ix, iy + 1) * (1 - tx) + a(ix + 1, iy + 1) * tx) * ty;
  };
  let x = -6, y = y0, vx = speed, vy = 0, t = 0, window = x, windowT = 0;
  for (let step = 0; step < 4800; step++) {
    t += dt;
    let dx = at(x, y, 0), dy = at(x, y, 1);
    const l = Math.hypot(dx, dy);
    if (l > 0.01) { dx /= l; dy /= l; } else { dx = 1; dy = 0; }
    const sd = at(x, y, 2);
    const k = Math.max(0, Math.min(1, (sd - (radius + 4)) / 36)), room = k * k * (3 - 2 * k);
    const ang = ((seed - 0.5) * 1.1 + 0.45 * Math.sin(t * 0.7 + seed * 60)) * room;
    const sa = Math.sin(ang), ca = Math.cos(ang);
    const spd = speed * (0.86 + 0.28 * seed);
    const m = 1 - Math.exp(-dt * 9);
    vx += (( dx * ca - dy * sa) * spd - vx) * m; vy += ((dx * sa + dy * ca) * spd - vy) * m;
    x += vx * dt; y += vy * dt;
    const s2 = at(x, y, 2);
    if (s2 < radius) {
      const gx = at(x + 3, y, 2) - at(x - 3, y, 2), gy = at(x, y + 3, 2) - at(x, y - 3, 2), g = Math.hypot(gx, gy);
      if (g > 0.01) {
        const nx = gx / g, ny = gy / g, push = Math.min(radius - s2, 6);
        x += nx * push; y += ny * push;
        const into = Math.min(vx * nx + vy * ny, 0); vx -= nx * into; vy -= ny * into;
      }
    }
    if (x >= WORLD_W - 2) return { done: true, time: t, stuck: false };
    if (t - windowT > 6) { if (x - window < 40) return { done: false, time: t, stuck: true, x, y }; window = x; windowT = t; }
  }
  return { done: false, time: t, stuck: true, x, y };
}

// Reports every way a map can trap enemies. ok is true only when all checks pass.
export function analyzeMap(map) {
  const rep = { ok: true, problems: [], bucketCells: 0, orphanCells: 0, worstDetour: 0 };
  const fail = (msg) => { rep.ok = false; rep.problems.push(msg); };
  if (!(map.spawnY1 - map.spawnY0 > 300)) fail('entry too narrow');

  // 1. free space the flow field cannot leave (sealed pockets) and free space where it points backwards
  const back = new Uint8Array(FW * FH);
  for (let i = 0; i < FW * FH; i++) {
    if (map.sdf[i] < 10) continue;
    if (!isFinite(map.cost[i])) { rep.orphanCells++; continue; }
    // cells hugging a rock's upstream face always lean away from it, so only count open ground
    if (map.sdf[i] >= 24 && map.field[i * 4] < -0.3) back[i] = 1;
  }
  if (rep.orphanCells > 0) fail(`${rep.orphanCells} cells of sealed space`);
  // biggest connected clump of backward-pointing cells
  const seen = new Uint8Array(FW * FH), stack = [];
  for (let s = 0; s < FW * FH; s++) {
    if (!back[s] || seen[s]) continue;
    let n = 0; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(); n++;
      const cx = i % FW, cy = (i / FW) | 0;
      for (const j of [i - 1, i + 1, i - FW, i + FW]) {
        if (j < 0 || j >= FW * FH || seen[j] || !back[j]) continue;
        if ((j === i - 1 && cx === 0) || (j === i + 1 && cx === FW - 1)) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    rep.bucketCells = Math.max(rep.bucketCells, n);
  }
  if (rep.bucketCells > 40) fail(`bucket of ${rep.bucketCells} cells`);

  // 2. walkers from every spawn row, thin and fat, must reach the gate without stalling
  const rows = [];
  for (let y = map.spawnY0; y <= map.spawnY1; y += 24) rows.push(y);
  const straight = WORLD_W / 50;
  for (const radius of [5, 14, MAX_ENEMY_RADIUS]) {
    for (let r = 0; r < rows.length; r++) {
      for (const seed of [0.05, 0.5, 0.95]) {
        const res = walkAgent(map, rows[r], (seed + r * 0.137) % 1, radius);
        if (!res.done) { fail(`walker r${radius} stuck near ${Math.round(res.x)},${Math.round(res.y)}`); break; }
        rep.worstDetour = Math.max(rep.worstDetour, res.time / straight);
      }
      if (!rep.ok) break;
    }
    if (!rep.ok) break;
  }
  if (rep.ok && rep.worstDetour > 2.2) fail(`path is ${rep.worstDetour.toFixed(2)}x the straight line`);
  return rep;
}

// Rolls seeds until one passes. Returns the validated layout, its field and the seed actually used.
export function generateMap(seed = Math.floor(Math.random() * 1e6)) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const s = (seed + attempt * 7919) % 1000000;
    const layout = drawLayout(s);
    if (layout.rocks.length < 5) continue;
    const map = buildField(layout);
    const report = analyzeMap(map);
    if (!report.ok) continue;
    layout.ore = placeOre(map, s);
    if (layout.ore.length < 4) continue;
    layout.seed = s;
    return { layout, map, seed: s, attempts: attempt + 1 };
  }
  // never expected, but never leave the player without a map
  const map = buildField(SKETCH_LAYOUT);
  return { layout: { ...SKETCH_LAYOUT, ore: placeOre(map, 1) }, map, seed, attempts: 60, fallback: true };
}

export function sketchMap() {
  const map = buildField(SKETCH_LAYOUT);
  return { layout: { ...SKETCH_LAYOUT, ore: placeOre(map, 7) }, map, seed: 0, attempts: 0 };
}

// Map geometry (traced from the paper sketch) plus the static fields the GPU simulation samples:
// a signed distance field of the terrain and a flow field pointing toward the gate on the right.
import { WORLD_W, WORLD_H, BUILD_DEPTH } from './data.js';

// Raw coordinates are in sketch pixels; sk() maps them to the 1600x900 world.
const sk = ([x, y]) => [(x - 120) * 1.2308, (y - 200) * 1.2329];

const TOP_WALL = [[-60, 215], [125, 215], [210, 205], [260, 225], [330, 235], [410, 250], [500, 245], [540, 262], [560, 300],
  [590, 335], [640, 350], [700, 365], [760, 378], [810, 400], [840, 405], [860, 375], [855, 350], [880, 310], [910, 285],
  [960, 288], [1010, 285], [1060, 305], [1100, 318], [1150, 300], [1190, 270], [1225, 265], [1300, 258], [1480, 250]];
const BOTTOM_WALL = [[-60, 905], [120, 900], [180, 890], [240, 880], [300, 905], [380, 915], [450, 900], [520, 910], [570, 915],
  [620, 890], [670, 870], [730, 830], [745, 790], [790, 740], [835, 750], [870, 765], [930, 790], [980, 810], [1010, 845],
  [1060, 850], [1100, 880], [1150, 905], [1200, 880], [1240, 870], [1300, 880], [1370, 900], [1480, 905]];

const ROCKS_RAW = [
  [[345, 360], [390, 312], [450, 300], [510, 300], [545, 330], [570, 400], [540, 450], [490, 470], [400, 470], [345, 430]],
  [[600, 500], [610, 455], [640, 430], [685, 432], [695, 470], [675, 520], [690, 555], [640, 565], [600, 535]],
  [[275, 520], [310, 515], [340, 565], [400, 605], [470, 625], [520, 640], [570, 625], [615, 622], [660, 640], [670, 690],
    [620, 700], [540, 740], [550, 765], [490, 772], [420, 745], [330, 745], [280, 728], [255, 675], [235, 615], [245, 570]],
  [[765, 610], [790, 575], [830, 570], [870, 585], [895, 620], [890, 670], [840, 685], [790, 690], [765, 650]],
  [[925, 495], [935, 440], [975, 405], [1030, 405], [1075, 440], [1090, 490], [1060, 535], [1000, 550], [945, 545]],
  [[1050, 705], [1070, 640], [1115, 605], [1175, 590], [1230, 615], [1270, 660], [1260, 705], [1210, 745], [1130, 770], [1085, 765]],
];

const wallPoly = (line, edgeY) => [...line.map(sk), sk([line[line.length - 1][0], edgeY]), sk([line[0][0], edgeY])];
export const WALLS = [wallPoly(TOP_WALL, -300), wallPoly(BOTTOM_WALL, 1500)];
export const ROCKS = ROCKS_RAW.map((p) => p.map(sk));
// A layout is the whole level: wall polygons (void), rock polygons (buildable) and ore patches.
export const SKETCH_LAYOUT = { name: 'Sketch canyon', walls: WALLS, rocks: ROCKS };

export const CELL = 4;
export const FW = WORLD_W / CELL;
export const FH = WORLD_H / CELL;

function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Felzenszwalb squared euclidean distance transform on a w*h grid; f holds 0 at sources, a large number elsewhere.
function edt(f, w, h) {
  const INF = 1e12;
  const d = new Float64Array(w * h);
  const n = Math.max(w, h);
  const v = new Int32Array(n), z = new Float64Array(n + 1), col = new Float64Array(n);
  const pass = (len, get, set) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      for (;;) {
        const p = v[k];
        s = (get(q) + q * q - (get(p) + p * p)) / (2 * q - 2 * p);
        if (s <= z[k] && k > 0) k--; else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      set(q, (q - p) * (q - p) + get(p));
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = f[y * w + x];
    pass(h, (i) => col[i], (i, val) => { d[i * w + x] = val; });
  }
  const row = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = d[y * w + x];
    pass(w, (i) => row[i], (i, val) => { d[y * w + i] = val; });
  }
  return d;
}

class MinHeap {
  constructor(cap) { this.k = new Float32Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

export function buildField(layout = SKETCH_LAYOUT) {
  const N = FW * FH;
  const rockId = new Uint8Array(N); // 1-based rock index, 0 = free or wall
  const solid = new Uint8Array(N);
  const boxes = [...layout.walls.map((p) => ({ p, wall: true })), ...layout.rocks.map((p, i) => ({ p, id: i + 1 }))].map((o) => {
    const xs = o.p.map((q) => q[0]), ys = o.p.map((q) => q[1]);
    return { ...o, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  for (let cy = 0; cy < FH; cy++) {
    for (let cx = 0; cx < FW; cx++) {
      const x = (cx + 0.5) * CELL, y = (cy + 0.5) * CELL;
      for (const b of boxes) {
        if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
        if (inPoly(b.p, x, y)) { solid[cy * FW + cx] = 1; if (!b.wall) rockId[cy * FW + cx] = b.id; break; }
      }
    }
  }
  // signed distance in world units: positive in free space, negative inside terrain
  const toSolid = new Float64Array(N), toFree = new Float64Array(N);
  for (let i = 0; i < N; i++) { toSolid[i] = solid[i] ? 0 : 1e12; toFree[i] = solid[i] ? 1e12 : 0; }
  const dS = edt(toSolid, FW, FH), dF = edt(toFree, FW, FH);
  const sdf = new Float32Array(N);
  for (let i = 0; i < N; i++) sdf[i] = solid[i] ? -(Math.sqrt(dF[i]) - 0.5) * CELL : (Math.sqrt(dS[i]) - 0.5) * CELL;

  // cost-to-goal with a soft penalty for hugging walls, 8-connected Dijkstra from the right edge
  const cost = new Float32Array(N).fill(Infinity);
  const heap = new MinHeap(N * 4);
  for (let cy = 0; cy < FH; cy++) {
    const i = cy * FW + FW - 1;
    if (!solid[i] && sdf[i] > 6) { cost[i] = 0; heap.push(0, i); }
  }
  const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const pen = (s) => { const t = Math.max(0, (34 - s) / 34); return 1 + 7 * t * t; };
  while (heap.n) {
    const i = heap.pop();
    const cx = i % FW, cy = (i / FW) | 0;
    const ci = cost[i];
    for (const [dx, dy] of nb) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= FW || ny >= FH) continue;
      const j = ny * FW + nx;
      if (solid[j] || sdf[j] < 5) continue;
      const nc = ci + (dx && dy ? 1.414 : 1) * pen(sdf[j]);
      if (nc < cost[j]) { cost[j] = nc; heap.push(nc, j); }
    }
  }

  const field = new Float32Array(N * 4);
  for (let cy = 0; cy < FH; cy++) {
    for (let cx = 0; cx < FW; cx++) {
      const i = cy * FW + cx;
      field[i * 4 + 2] = sdf[i];
      if (!isFinite(cost[i])) continue;
      let fx = 0, fy = 0;
      for (const [dx, dy] of nb) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= FW || ny >= FH) continue;
        const c = cost[ny * FW + nx];
        if (!isFinite(c)) continue;
        const gain = cost[i] - c;
        if (gain <= 0) continue;
        const l = Math.hypot(dx, dy);
        fx += (dx / l) * gain; fy += (dy / l) * gain;
      }
      const m = Math.hypot(fx, fy);
      if (m > 1e-6) { field[i * 4] = fx / m; field[i * 4 + 1] = fy / m; } else { field[i * 4] = 1; }
    }
  }
  // enemies enter along the left edge: find the free span there
  let y0 = FH, y1 = 0;
  for (let cy = 0; cy < FH; cy++) {
    const i = cy * FW + 3;
    if (sdf[i] > 14 && isFinite(cost[i])) { y0 = Math.min(y0, cy); y1 = Math.max(y1, cy); }
  }
  return { field, sdf, rockId, solid, cost, spawnY0: (y0 + 0.5) * CELL, spawnY1: (y1 + 0.5) * CELL };
}

export function makeBuildCheck(map) {
  const at = (x, y) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= FW || cy >= FH) return -1;
    return cy * FW + cx;
  };
  return {
    // depth into a buildable rock in world units (<= 0 when not on a rock)
    rockDepth(x, y) {
      const i = at(x, y);
      if (i < 0 || !map.rockId[i]) return 0;
      return -map.sdf[i];
    },
    canBuild(x, y) { return this.rockDepth(x, y) >= BUILD_DEPTH; },
  };
}

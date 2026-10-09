// Ball physics + procedural Voronoi cave. No DOM access.
//
// Cave: random sites -> Lloyd relaxation -> each Voronoi cell is shrunk by half the channel width, so the
// rocks are convex polygons and the gaps between them are the Voronoi edges ("veins") balls tumble through.
// Balls: semi-implicit Euler, gravity + air drag, spatial-hash ball/ball collisions, ball/segment collisions.
import { W, H, GOBLINS, mulberry32 } from './data.js';

export const LEAK_Y = H - 14;       // balls reaching this line hit the castle
export const GRAV = 180, DRAG = 2.0;
const Y0 = 40, Y1 = 500;            // rock region (spawn zone above, castle runout below)
const GAP = 18;                     // rock-to-rock channel = 2 * GAP
const SHIFT_TB = 36, SHIFT_LR = 26; // clearance to top/bottom and side walls
const N_SITES = 20, EMPTY_P = 0.12;
const CELL = 32, OY = 60;
const BCOLS = Math.ceil(W / CELL), BROWS = Math.ceil((H + 2 * OY) / CELL);
const E_BALL = 0.25, E_WALL = 0.3, MU = 0.35, VMAX = 320, KICK_AFTER = 0.8;

function clip(poly, nx, ny, c) {
  const out = [], n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[2 * i], ay = poly[2 * i + 1], bx = poly[2 * j], by = poly[2 * j + 1];
    const da = nx * ax + ny * ay - c, db = nx * bx + ny * by - c;
    if (da <= 0) out.push(ax, ay);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db); out.push(ax + (bx - ax) * t, ay + (by - ay) * t); }
  }
  return out;
}

function cellPoly(i, sites, ghosts, shiftReal, shiftTB, shiftLR) {
  let poly = [-300, -300, W + 300, -300, W + 300, H + 300, -300, H + 300];
  const sx = sites[i][0], sy = sites[i][1];
  const cut = (ox, oy, shift) => {
    const dx = ox - sx, dy = oy - sy, L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    const nx = dx / L, ny = dy / L;
    poly = clip(poly, nx, ny, nx * (sx + ox) / 2 + ny * (sy + oy) / 2 - shift);
  };
  for (let j = 0; j < sites.length && poly.length >= 6; j++) if (j !== i) cut(sites[j][0], sites[j][1], shiftReal);
  for (let k = 0; k < ghosts.length && poly.length >= 6; k++) cut(ghosts[k][0], ghosts[k][1], ghosts[k][2] ? shiftLR : shiftTB);
  return poly;
}

function centroid(poly, fb) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = poly.length / 2; i < n; i++) {
    const j = (i + 1) % n, x0 = poly[2 * i], y0 = poly[2 * i + 1], x1 = poly[2 * j], y1 = poly[2 * j + 1];
    const f = x0 * y1 - x1 * y0; a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  return Math.abs(a) < 1e-6 ? fb : [cx / (3 * a), cy / (3 * a)];
}
const polyArea = p => { let a = 0; for (let i = 0, n = p.length / 2; i < n; i++) { const j = (i + 1) % n; a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]; } return Math.abs(a) / 2; };

function makeGhosts(sites) {
  const g = [];
  for (const [x, y] of sites) {
    g.push([-x, y, 1], [2 * W - x, y, 1], [x, 2 * Y0 - y, 0], [x, 2 * Y1 - y, 0]);
  }
  return g;
}

export class Cave {
  constructor(seed) {
    this.seed = seed;
    const rnd = mulberry32(seed * 2654435761 + 17);
    // best-candidate sampling for evenly spread sites
    let sites = [];
    for (let k = 0; k < N_SITES; k++) {
      let best = null, bd = -1;
      for (let c = 0; c < 14; c++) {
        const p = [rnd() * W, Y0 + rnd() * (Y1 - Y0)];
        let d = 1e9; for (const q of sites) d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1]));
        if (d > bd) { bd = d; best = p; }
      }
      sites.push(best);
    }
    for (let it = 0; it < 2; it++) { // Lloyd relaxation
      const gh = makeGhosts(sites);
      sites = sites.map((s, i) => {
        const c = centroid(cellPoly(i, sites, gh, 0, 0, 0), s);
        return [Math.min(W - 5, Math.max(5, c[0])), Math.min(Y1 - 5, Math.max(Y0 + 5, c[1]))];
      });
    }
    this.sites = sites;
    const gh = makeGhosts(sites);
    this.rocks = [];
    sites.forEach((s, i) => {
      const poly = cellPoly(i, sites, gh, GAP, SHIFT_TB, SHIFT_LR);
      if (poly.length >= 6 && polyArea(poly) > 150 && rnd() > EMPTY_P) this.rocks.push(poly);
    });
    this.buildSegments();
  }

  buildSegments() {
    const segs = [];
    for (const p of this.rocks) {
      const n = p.length / 2;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; segs.push([p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]]); }
    }
    segs.push([0, -800, 0, H + 100], [W, -800, W, H + 100]);   // side walls
    const n = this.nSeg = segs.length;
    this.sx = new Float32Array(n); this.sy = new Float32Array(n);
    this.sdx = new Float32Array(n); this.sdy = new Float32Array(n); this.sinv = new Float32Array(n);
    segs.forEach(([x1, y1, x2, y2], i) => {
      this.sx[i] = x1; this.sy[i] = y1; this.sdx[i] = x2 - x1; this.sdy[i] = y2 - y1;
      this.sinv[i] = 1 / Math.max(1e-6, (x2 - x1) ** 2 + (y2 - y1) ** 2);
    });
    // uniform grid -> CSR lists of segment ids near each cell
    const lists = Array.from({ length: BCOLS * BROWS }, () => []);
    const pad = 16;
    segs.forEach(([x1, y1, x2, y2], i) => {
      const c0 = Math.max(0, Math.floor((Math.min(x1, x2) - pad) / CELL)), c1 = Math.min(BCOLS - 1, Math.floor((Math.max(x1, x2) + pad) / CELL));
      const r0 = Math.max(0, Math.floor((Math.min(y1, y2) - pad + OY) / CELL)), r1 = Math.min(BROWS - 1, Math.floor((Math.max(y1, y2) + pad + OY) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) lists[r * BCOLS + c].push(i);
    });
    this.cellStart = new Int32Array(lists.length + 1);
    let tot = 0; lists.forEach((l, i) => { this.cellStart[i] = tot; tot += l.length; });
    this.cellStart[lists.length] = tot;
    this.cellSegs = new Int32Array(tot);
    let k = 0; for (const l of lists) for (const id of l) this.cellSegs[k++] = id;
  }
}

export class BallWorld {
  constructor(cave, max) {
    this.cave = cave; this.max = max; this.n = 0;
    const F = () => new Float32Array(max);
    this.x = F(); this.y = F(); this.vx = F(); this.vy = F(); this.r = F(); this.invM = F();
    this.drag = F(); this.slowT = F(); this.slowF = F(); this.rest = F();
    this.head = new Int32Array(BCOLS * BROWS); this.nxt = new Int32Array(max);
    this.rs = 12345;
  }
  rand() { // xorshift32 -> [0,1)
    let s = this.rs; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.rs = s; return (s >>> 0) / 4294967296;
  }
  add(x, y, r, drag, vy = 0) {
    if (this.n >= this.max) return -1;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.vx[i] = 0; this.vy[i] = vy; this.r[i] = r; this.invM[i] = 36 / (r * r);
    this.drag[i] = drag; this.slowT[i] = 0; this.slowF[i] = 1; this.rest[i] = 0;
    return i;
  }
  copy(from, to) {
    for (const a of [this.x, this.y, this.vx, this.vy, this.r, this.invM, this.drag, this.slowT, this.slowF, this.rest]) a[to] = a[from];
  }
  /** Add an instantaneous velocity change (scaled by sqrt of inverse mass: heavy balls budge less). */
  push(i, dvx, dvy) { const m = Math.sqrt(this.invM[i]); this.vx[i] += dvx * m; this.vy[i] += dvy * m; }

  step(dt, sub = 3) { const h = dt / sub; for (let s = 0; s < sub; s++) this.substep(h); }

  substep(h) {
    const { n, x, y, vx, vy, r, invM, drag, slowT, slowF, rest, head, nxt, cave } = this;
    // integrate
    for (let i = 0; i < n; i++) {
      let f = 1;
      if (slowT[i] > 0) { slowT[i] -= h; f = slowF[i]; }
      const hf = h * f, k = DRAG * drag[i];
      vx[i] -= vx[i] * k * hf;
      vy[i] += (GRAV - vy[i] * k) * hf;
      const v2 = vx[i] * vx[i] + vy[i] * vy[i];
      if (v2 > VMAX * VMAX) { const s = VMAX / Math.sqrt(v2); vx[i] *= s; vy[i] *= s; }
      x[i] += vx[i] * hf; y[i] += vy[i] * hf;
    }
    // ball <-> ball via spatial hash
    head.fill(-1);
    for (let i = 0; i < n; i++) {
      const c = Math.min(BCOLS - 1, Math.max(0, (x[i] / CELL) | 0)), rr = Math.min(BROWS - 1, Math.max(0, ((y[i] + OY) / CELL) | 0));
      const cell = rr * BCOLS + c; nxt[i] = head[cell]; head[cell] = i;
    }
    for (let i = 0; i < n; i++) {
      const cc = Math.min(BCOLS - 1, Math.max(0, (x[i] / CELL) | 0)), cr = Math.min(BROWS - 1, Math.max(0, ((y[i] + OY) / CELL) | 0));
      for (let rr = Math.max(0, cr - 1); rr <= Math.min(BROWS - 1, cr + 1); rr++) {
        for (let c = Math.max(0, cc - 1); c <= Math.min(BCOLS - 1, cc + 1); c++) {
          for (let j = head[rr * BCOLS + c]; j >= 0; j = nxt[j]) {
            if (j <= i) continue;
            const dx = x[j] - x[i], dy = y[j] - y[i], rs = r[i] + r[j], d2 = dx * dx + dy * dy;
            if (d2 >= rs * rs) continue;
            let d = Math.sqrt(d2), nx, ny;
            if (d < 1e-4) { nx = 0; ny = 1; d = 0; } else { nx = dx / d; ny = dy / d; }
            const wsum = invM[i] + invM[j], pen = (rs - d) * 0.8;
            x[i] -= nx * pen * invM[i] / wsum; y[i] -= ny * pen * invM[i] / wsum;
            x[j] += nx * pen * invM[j] / wsum; y[j] += ny * pen * invM[j] / wsum;
            const vn = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny;
            if (vn < 0) {
              const J = -(1 + E_BALL) * vn / wsum;
              vx[i] -= J * invM[i] * nx; vy[i] -= J * invM[i] * ny;
              vx[j] += J * invM[j] * nx; vy[j] += J * invM[j] * ny;
            }
          }
        }
      }
    }
    // ball <-> rock/walls
    const { sx, sy, sdx, sdy, sinv, cellStart, cellSegs } = cave;
    for (let i = 0; i < n; i++) {
      const cc = Math.min(BCOLS - 1, Math.max(0, (x[i] / CELL) | 0)), cr = Math.min(BROWS - 1, Math.max(0, ((y[i] + OY) / CELL) | 0));
      const cell = cr * BCOLS + cc, ri = r[i], r2 = ri * ri;
      for (let k = cellStart[cell], e = cellStart[cell + 1]; k < e; k++) {
        const s = cellSegs[k];
        let t = ((x[i] - sx[s]) * sdx[s] + (y[i] - sy[s]) * sdy[s]) * sinv[s];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x[i] - (sx[s] + t * sdx[s]), ey = y[i] - (sy[s] + t * sdy[s]), d2 = ex * ex + ey * ey;
        if (d2 >= r2) continue;
        let nx, ny, d = Math.sqrt(d2);
        if (d < 1e-4) { const L = Math.sqrt(1 / sinv[s]); nx = -sdy[s] / L; ny = sdx[s] / L; d = 0; } else { nx = ex / d; ny = ey / d; }
        const pen = ri - d;
        x[i] += nx * pen; y[i] += ny * pen;
        const vn = vx[i] * nx + vy[i] * ny;
        if (vn < 0) {
          vx[i] -= (1 + E_WALL) * vn * nx; vy[i] -= (1 + E_WALL) * vn * ny;
          const tx = -ny, ty = nx, vt = vx[i] * tx + vy[i] * ty;
          const fr = Math.min(Math.abs(vt), -MU * (1 + E_WALL) * vn) * Math.sign(vt);
          vx[i] -= fr * tx; vy[i] -= fr * ty;
        }
      }
      if (x[i] < ri) x[i] = ri; else if (x[i] > W - ri) x[i] = W - ri;
      // keep resting balls from sticking on flat spots / in pockets
      if (vx[i] * vx[i] + vy[i] * vy[i] < 16) {
        rest[i] += h;
        if (rest[i] > KICK_AFTER) { vx[i] += (this.rand() - 0.5) * 80; vy[i] -= 20 + this.rand() * 30; rest[i] = 0; }
      } else rest[i] = 0;
    }
  }
}

/** Drop a mixed batch through the empty cave; it is valid when every ball reaches the castle line. */
export function validateCave(cave) {
  const w = new BallWorld(cave, 64), rnd = mulberry32(99);
  const mix = [0, 0, 0, 0, 1, 1, 2, 3];
  for (let k = 0; k < 40; k++) {
    const g = GOBLINS[mix[k % mix.length]];
    w.add(g.r + 4 + rnd() * (W - 2 * g.r - 8), -g.r - k * 22, g.r, g.drag, 20);
  }
  let t = 0, sum = 0, done = 0;
  while (w.n > 0 && t < 120) {
    w.step(1 / 60); t += 1 / 60;
    for (let i = w.n - 1; i >= 0; i--) if (w.y[i] >= LEAK_Y) { sum += t; done++; w.n--; if (i !== w.n) w.copy(w.n, i); }
  }
  return { ok: w.n === 0, avgTime: done ? sum / done : Infinity, stuck: w.n };
}

/** First seed (from the given one) whose cave passes validation. */
export function buildCave(seed) {
  let last = null;
  for (let k = 0; k < 40; k++) {
    const cave = new Cave(seed + k * 7919), v = validateCave(cave);
    cave.validation = v; cave.attempts = k + 1; last = cave;
    if (v.ok) return cave;
  }
  return last;
}

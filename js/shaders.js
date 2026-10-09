import { ENEMIES, WORLD_W, WORLD_H, MAX_ENEMIES, MAX_TOWERS, ENEMY_KINDS } from './data.js';
import { FW, FH, CELL } from './map.js';

export const GRID_CELL = 24;
export const GRID_CAP = 32;
export const GW = Math.ceil(WORLD_W / GRID_CELL);
export const GH = Math.ceil(WORLD_H / GRID_CELL);

// Byte layouts shared with gpu.js
export const ENEMY_STRIDE = 56;  // pos2 vel2 hp maxhp kind burn burnDps seed slow spread shield shieldT
export const TCFG_STRIDE = 96;   // pos2 kind level range dmg rate radius live flight splash pierce pct slow ignite spread ramp r g b ap exec crit pad
export const TSTATE_STRIDE = 64; // aim2 tgt2 shellTo2 boomPos2 cd fire shellT boom evt tgtIdx heat used
export const PARAM_FLOATS = 28;

const f = (n) => Number(n).toFixed(3);
const arr = (a) => `array<f32,${a.length}>(${a.map(f).join(',')})`;

const COMMON = /* wgsl */`
const WORLD_W = ${f(WORLD_W)};
const WORLD_H = ${f(WORLD_H)};
const MAXE = ${MAX_ENEMIES}u;
const MAXT = ${MAX_TOWERS}u;
const GW = ${GW}i;
const GH = ${GH}i;
const GCELL = ${f(GRID_CELL)};
const GCAP = ${GRID_CAP}u;
const FW = ${FW}i;
const FH = ${FH}i;
const FCELL = ${f(CELL)};

struct Params {
  dt: f32, time: f32, spawnStart: u32, numTowers: u32,
  hpScale: f32, goldMult: f32, spawnY0: f32, spawnY1: f32,
  maxUsed: u32, frame: u32, spdScale: f32, pad0: u32,
  counts: array<vec4<u32>, 4>, // spawn count per enemy kind, indexed by kind
};
struct Enemy { pos: vec2f, vel: vec2f, hp: f32, maxhp: f32, kind: u32, burn: f32, burnDps: f32, seed: f32, slow: f32, spread: f32, shield: f32, shieldT: f32 };
struct Tower {
  pos: vec2f, kind: u32, level: u32, range: f32, dmg: f32, rate: f32, radius: f32, live: u32,
  flight: f32, splash: f32, pierce: f32, pct: f32, slow: f32, ignite: f32, spread: f32, ramp: f32, cr: f32, cg: f32, cb: f32,
  ap: f32, exec: f32, crit: f32, pad: f32,
};
struct TState {
  aim: vec2f, tgt: vec2f, shellTo: vec2f, boomPos: vec2f,
  cd: f32, fire: f32, shellT: f32, boom: f32, evt: u32, tgtIdx: u32, heat: f32, used: f32, // used: shots or seconds fired, read back for ammo accounting
};

const NK = ${ENEMY_KINDS}u;
var<private> E_RAD: array<f32,${ENEMIES.length}> = ${arr([0, ...ENEMIES.slice(1).map((e) => e.radius)])};
var<private> E_SPD: array<f32,${ENEMIES.length}> = ${arr([0, ...ENEMIES.slice(1).map((e) => e.speed)])};
var<private> E_HP: array<f32,${ENEMIES.length}> = ${arr([0, ...ENEMIES.slice(1).map((e) => e.hp)])};
var<private> E_ARM: array<f32,${ENEMIES.length}> = ${arr([0, ...ENEMIES.slice(1).map((e) => e.armor)])};
var<private> E_LEAK: array<u32,${ENEMIES.length}> = array<u32,${ENEMIES.length}>(0u, ${ENEMIES.slice(1).map((e) => e.leak + 'u').join(',')});
var<private> E_REW: array<f32,${ENEMIES.length}> = ${arr([0, ...ENEMIES.slice(1).map((e) => e.reward)])};

// live: 0 empty slot, 1 working tower, 2 tower out of ammo
// phantoms blink out of reach for a third of a cycle, on the simulation clock
fn isPhased(e: Enemy, t: f32) -> bool { return e.kind == 8u && fract(t * 0.33 + e.seed * 7.0) < 0.3; }
`;

export const COMPUTE = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> enemiesIn: array<Enemy>;
@group(0) @binding(2) var<storage, read_write> enemiesOut: array<Enemy>;
@group(0) @binding(3) var<storage, read> field: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> grid: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> tcfg: array<Tower>;
@group(0) @binding(6) var<storage, read_write> tstate: array<TState>;
@group(0) @binding(7) var<storage, read_write> counters: array<atomic<u32>>; // kills, goldx16, leaks, alive

fn hash(x: u32) -> f32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) / 4294967296.0;
}
fn fieldAt(ix: i32, iy: i32) -> vec4f {
  return field[clamp(iy, 0, FH - 1) * FW + clamp(ix, 0, FW - 1)];
}
fn sampleField(p: vec2f) -> vec4f {
  let g = p / FCELL - vec2f(0.5);
  let b = floor(g);
  let t = g - b;
  let i = vec2i(b);
  return mix(mix(fieldAt(i.x, i.y), fieldAt(i.x + 1, i.y), t.x),
             mix(fieldAt(i.x, i.y + 1), fieldAt(i.x + 1, i.y + 1), t.x), t.y);
}
fn cellOf(p: vec2f) -> vec2i {
  return vec2i(clamp(i32(floor(p.x / GCELL)), 0, GW - 1), clamp(i32(floor(p.y / GCELL)), 0, GH - 1));
}
fn cross2(a: vec2f, b: vec2f) -> f32 { return a.x * b.y - a.y * b.x; }

@compute @workgroup_size(64)
fn clearGrid(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i < u32(GW * GH)) { atomicStore(&grid[i], 0u); }
  if (i == 0u) { atomicStore(&counters[3], 0u); }
}

@compute @workgroup_size(64)
fn buildGrid(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= MAXE) { return; }
  let e = enemiesIn[i];
  if (e.kind == 0u) { return; }
  let c = cellOf(e.pos);
  let cell = u32(c.y * GW + c.x);
  let n = atomicAdd(&grid[cell], 1u);
  if (n < GCAP) { atomicStore(&grid[u32(GW * GH) + cell * GCAP + n], i); }
}

@compute @workgroup_size(64)
fn towers(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (t >= P.numTowers) { return; }
  let c = tcfg[t];
  var s = tstate[t];
  if (c.live == 0u) { s.fire = 0.0; s.shellT = -1.0; s.boom = 0.0; s.evt = 0u; tstate[t] = s; return; }
  if (c.live == 2u) { s.fire = 0.0; s.shellT = -1.0; s.evt = 0u; s.heat = 0.0; s.boom = max(0.0, s.boom - P.dt * 2.2); tstate[t] = s; return; }
  s.evt = 0u;
  s.cd -= P.dt;
  if (c.kind == 0u) { s.fire = max(0.0, s.fire - P.dt * 9.0); } else { s.fire = max(0.0, s.fire - P.dt * 5.0); }
  s.boom = max(0.0, s.boom - P.dt * 2.2);

  // pick the target: furthest along, or for mortars the densest clump
  var best = -1e9;
  var bi = 0xffffffffu;
  var bp = vec2f(0.0);
  var bv = vec2f(0.0);
  let minR = select(0.0, 70.0, c.kind == 3u);
  for (var i = 0u; i < P.maxUsed; i++) {
    let e = enemiesIn[i];
    if (e.kind == 0u || isPhased(e, P.time)) { continue; }
    let d = distance(e.pos, c.pos);
    if (d > c.range || d < minR) { continue; }
    var score = e.pos.x;
    if (c.kind == 3u) {
      let cc = cellOf(e.pos);
      score = f32(min(atomicLoad(&grid[u32(cc.y * GW + cc.x)]), GCAP)) * 100.0 + e.pos.x * 0.01;
    }
    if (score > best) { best = score; bi = i; bp = e.pos; bv = e.vel; }
  }
  let found = bi != 0xffffffffu;
  if (found) {
    let want = normalize(bp - c.pos);
    if (dot(s.aim, s.aim) < 0.5) { s.aim = want; }
    else { s.aim = normalize(mix(s.aim, want, select(0.45, 0.8, c.kind == 3u))); }
  }

  if (c.kind == 0u) {
    if (found && s.cd <= 0.0) {
      let want = normalize(bp - c.pos);
      s.aim = want;
      s.fire = 1.0; s.tgt = select(bp, c.pos + want * c.range, c.pierce > 0.0); s.tgtIdx = bi; s.evt = 1u;
      s.cd = select(s.cd + 1.0 / c.rate, 1.0 / c.rate, s.cd < -P.dt);
      s.used += 1.0;
    }
  } else if (c.kind == 1u || c.kind == 2u) {
    if (found) { s.fire = 1.0; s.evt = 1u; s.heat = min(1.0, s.heat + P.dt * 0.5); s.used += P.dt; }
    else { s.heat = max(0.0, s.heat - P.dt); }
  } else {
    if (s.shellT > 0.0) {
      s.shellT -= P.dt;
      if (s.shellT <= 0.0) { s.shellT = -1.0; s.evt = 1u; s.boom = 1.0; s.boomPos = s.shellTo; }
    }
    // a fresh tower starts with zeroed state, so "no shell in flight" means shellT <= 0
    if (found && s.cd <= 0.0 && s.shellT <= 0.0) {
      s.shellTo = bp + bv * c.flight;
      s.shellT = c.flight;
      s.cd = 1.0 / c.rate;
      s.used += 1.0;
    }
  }
  tstate[t] = s;
}

@compute @workgroup_size(64)
fn enemies(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= MAXE) { return; }
  var e = enemiesIn[i];

  if (e.kind == 0u) {
    let rel = (i + MAXE - P.spawnStart) % MAXE;
    var total = 0u;
    var k = 0u;
    for (var q = 1u; q <= NK; q++) {
      let cq = P.counts[q / 4u][q % 4u];
      if (rel >= total && rel < total + cq) { k = q; }
      total += cq;
    }
    if (rel < total && k != 0u) {
      let h1 = hash(i * 7u + P.frame * 13u);
      let h2 = hash(i * 131u + P.frame * 17u + 5u);
      let h3 = hash(i * 977u + P.frame * 29u + 11u);
      e.kind = k;
      e.pos = vec2f(-6.0 - h1 * 50.0, mix(P.spawnY0, P.spawnY1, h2));
      e.vel = vec2f(E_SPD[k], 0.0);
      e.maxhp = E_HP[k] * P.hpScale;
      e.hp = e.maxhp;
      e.burn = 0.0; e.burnDps = 0.0; e.seed = h3; e.slow = 0.0; e.spread = 0.0;
      e.shield = select(0.0, e.maxhp * 0.6, k == 9u); e.shieldT = 0.0;
    }
    enemiesOut[i] = e;
    return;
  }

  let k = e.kind;
  let r = E_RAD[k];

  // damage from towers (events computed this step by the tower pass)
  var dmg = 0.0;
  var slowIn = 0.0;
  for (var t = 0u; t < P.numTowers; t++) {
    let c = tcfg[t];
    if (c.live == 0u) { continue; }
    let s = tstate[t];
    if (s.evt == 0u) { continue; }
    var hit = false;
    var amt = 0.0;
    var tick = 1.0; // continuous towers scale their effects by dt
    if (c.kind == 0u) {
      if (c.pierce > 0.0) {
        let rel = e.pos - c.pos;
        let along = dot(rel, s.aim);
        if (along > 0.0 && along < c.range && abs(cross2(rel, s.aim)) < c.pierce + r) { hit = true; amt = c.dmg; }
      } else if (s.tgtIdx == i) {
        hit = true; amt = c.dmg;
      } else if (c.splash > 0.0 && distance(e.pos, s.tgt) < c.splash + r) {
        hit = true; amt = c.dmg * 0.5;
      }
    } else if (c.kind == 1u) {
      tick = P.dt;
      let rel = e.pos - c.pos;
      let along = dot(rel, s.aim);
      if (along > 0.0 && along < c.range && abs(cross2(rel, s.aim)) < c.radius + r) {
        hit = true; amt = c.dmg * (1.0 + s.heat * c.ramp) * tick;
      }
    } else if (c.kind == 2u) {
      tick = P.dt;
      let rel = e.pos - c.pos;
      let d = length(rel);
      if (d < c.range + r && d > 0.001 && dot(rel / d, s.aim) > c.radius) { hit = true; amt = c.dmg * tick; }
    } else {
      let d = distance(e.pos, s.boomPos);
      if (d < c.radius + r) { hit = true; amt = c.dmg * (1.0 - 0.5 * d / (c.radius + r)); }
    }
    if (hit) {
      if (c.exec > 0.0 && e.hp < e.maxhp * 0.25) { amt *= 1.0 + c.exec; }
      if (c.kind == 0u || c.kind == 3u) {
        if (c.crit > 0.0 && hash(i * 31u + t * 101u + P.frame * 7u) < c.crit) { amt *= 3.0; }
        amt = max(amt - E_ARM[k] * (1.0 - c.ap), amt * 0.3);
      }
      dmg += amt + c.pct * e.maxhp * tick;
      slowIn = max(slowIn, c.slow);
      if (c.ignite > 0.0) {
        e.burn = 2.5;
        e.burnDps = max(e.burnDps, c.ignite);
        e.spread = max(e.spread, c.spread);
      }
    }
  }
  e.slow = max(e.slow - P.dt * 0.5, slowIn);
  let phased = isPhased(e, P.time);
  if (phased) { dmg = 0.0; }
  // shields soak direct damage, then regrow once left alone; burning ignores them
  if (k == 9u) {
    let cap = e.maxhp * 0.6;
    if (dmg > 0.0) {
      let soak = min(e.shield, dmg);
      e.shield -= soak; dmg -= soak; e.shieldT = 0.0;
    } else {
      e.shieldT += P.dt;
      if (e.shieldT > 2.5) { e.shield = min(cap, e.shield + cap * 0.25 * P.dt); }
    }
  } else if (k == 8u) {
    e.shieldT = select(0.0, 1.0, phased); // render flag: faded while out of reach
  }
  if (e.burn > 0.0) {
    dmg += e.burnDps * P.dt;
    e.burn -= P.dt;
    if (e.burn <= 0.0) { e.burnDps = 0.0; e.spread = 0.0; }
  }
  e.hp -= dmg;
  if (e.hp <= 0.0) {
    atomicAdd(&counters[0], 1u);
    atomicAdd(&counters[1], u32(E_REW[k] * P.goldMult * 16.0 + 0.5));
    e.kind = 0u;
    enemiesOut[i] = e;
    return;
  }
  if (e.pos.x > WORLD_W + 4.0) {
    atomicAdd(&counters[2], E_LEAK[k]);
    e.kind = 0u;
    enemiesOut[i] = e;
    return;
  }

  // crowd separation through the spatial grid
  var push = vec2f(0.0);
  var catchDps = 0.0;
  var healed = false;
  var rallied = false;
  var catchSpread = 0.0;
  let cc = cellOf(e.pos);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let nx = cc.x + dx; let ny = cc.y + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) { continue; }
      let cell = u32(ny * GW + nx);
      let n = min(atomicLoad(&grid[cell]), GCAP);
      for (var q = 0u; q < n; q++) {
        let j = atomicLoad(&grid[u32(GW * GH) + cell * GCAP + q]);
        if (j == i) { continue; }
        let o = enemiesIn[j];
        let d = e.pos - o.pos;
        let rr = r + E_RAD[o.kind];
        let d2 = dot(d, d);
        if (o.kind == 7u && d2 < (rr + 20.0) * (rr + 20.0)) { healed = true; }
        if (o.kind == 12u && d2 < (rr + 34.0) * (rr + 34.0)) { rallied = true; }
        if (o.burn > 0.0 && o.spread > 0.5 && d2 < (rr + 9.0) * (rr + 9.0)) {
          catchDps = max(catchDps, o.burnDps * 0.8);
          catchSpread = max(catchSpread, o.spread - 0.34);
        }
        if (d2 < rr * rr) {
          if (d2 > 0.0001) {
            let dist = sqrt(d2);
            push += (d / dist) * ((rr - dist) / rr) * (2.0 * E_RAD[o.kind] / rr);
          } else {
            push += vec2f(hash(i + P.frame) - 0.5, hash(j + P.frame) - 0.5);
          }
        }
      }
    }
  }

  if (healed) { e.hp = min(e.maxhp, e.hp + e.maxhp * select(0.07, 0.008, k >= 11u) * P.dt); }
  if (catchDps > 0.0 && e.burn <= 0.5) { e.burn = 2.0; e.burnDps = catchDps; e.spread = catchSpread; }
  let f = sampleField(e.pos);
  var dir = f.xy;
  let fl = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / max(fl, 0.0001), fl > 0.01);
  // each enemy drifts at its own slowly changing angle off the flow line, so crowds fill the corridor
  let room = smoothstep(r + 4.0, r + 40.0, f.z);
  let ang = ((e.seed - 0.5) * 1.1 + 0.45 * sin(P.time * 0.7 + e.seed * 60.0)) * room;
  let sa = sin(ang); let ca = cos(ang);
  let wdir = vec2f(dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca);
  let rage = select(1.0, 1.0 + (1.0 - clamp(e.hp / e.maxhp, 0.0, 1.0)) * 1.3, k == 10u);
  let spd = E_SPD[k] * (0.86 + 0.28 * e.seed) * (1.0 - clamp(e.slow, 0.0, 0.75)) * rage * select(1.0, 1.35, rallied) * P.spdScale;
  let desired = wdir * spd + push * spd * 3.5;
  e.vel = mix(e.vel, desired, 1.0 - exp(-P.dt * 9.0));
  e.pos += e.vel * P.dt;

  // keep out of the terrain
  let sd = sampleField(e.pos).z;
  if (sd < r) {
    let g = vec2f(
      sampleField(e.pos + vec2f(3.0, 0.0)).z - sampleField(e.pos - vec2f(3.0, 0.0)).z,
      sampleField(e.pos + vec2f(0.0, 3.0)).z - sampleField(e.pos - vec2f(0.0, 3.0)).z);
    if (dot(g, g) > 0.0001) {
      let nrm = normalize(g);
      e.pos += nrm * min(r - sd, 6.0);
      e.vel -= nrm * min(dot(e.vel, nrm), 0.0);
    }
  }
  atomicAdd(&counters[3], 1u);
  enemiesOut[i] = e;
}
`;

export const RENDER = COMMON + /* wgsl */`
struct View { sx: f32, sy: f32, aa: f32, time: f32 };
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> en: array<Enemy>;
@group(0) @binding(2) var<storage, read> tc: array<Tower>;
@group(0) @binding(3) var<storage, read> ts: array<TState>;

var<private> CORNERS: array<vec2f,6> = array<vec2f,6>(
  vec2f(-1.0,-1.0), vec2f(1.0,-1.0), vec2f(-1.0,1.0), vec2f(-1.0,1.0), vec2f(1.0,-1.0), vec2f(1.0,1.0));
var<private> E_COL: array<vec3f,${ENEMIES.length}> = array<vec3f,${ENEMIES.length}>(vec3f(0.0),
  ${ENEMIES.slice(1).map((e) => `vec3f(${hex(e.color)})`).join(',')});

fn toClip(w: vec2f) -> vec4f { return vec4f(w.x * V.sx - 1.0, 1.0 - w.y * V.sy, 0.0, 1.0); }
fn cross2(a: vec2f, b: vec2f) -> f32 { return a.x * b.y - a.y * b.x; }
fn segDist(p: vec2f, a: vec2f, b: vec2f) -> vec2f { // x = distance, y = param along in world units
  let ab = b - a;
  let l = max(length(ab), 0.0001);
  let t = clamp(dot(p - a, ab) / (l * l), 0.0, 1.0);
  return vec2f(distance(p, a + ab * t), t * l);
}

struct EOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) col: vec4f,
  @location(2) @interpolate(flat) misc: vec4f,
};

@vertex
fn vsEnemy(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> EOut {
  var o: EOut;
  let e = en[ii];
  if (e.kind == 0u) { o.pos = vec4f(3.0, 3.0, 0.0, 1.0); return o; }
  let rad = E_RAD[e.kind];
  let hs = rad + 10.0;
  let c = CORNERS[vi];
  o.pos = toClip(e.pos + c * hs);
  o.uv = c * hs;
  var col = E_COL[e.kind];
  let hpf = clamp(e.hp / e.maxhp, 0.0, 1.0);
  col = mix(col * 0.45, col, 0.35 + 0.65 * hpf);
  col = mix(col, vec3f(0.45, 0.72, 1.0), clamp(e.slow, 0.0, 0.75) * 0.8);
  if (e.burn > 0.0) { col = mix(col, vec3f(1.0, 0.5, 0.18), 0.55 + 0.25 * sin(V.time * 30.0 + e.seed * 50.0)); }
  o.col = vec4f(col, 1.0);
  let shieldFrac = select(0.0, clamp(e.shield / (e.maxhp * 0.6), 0.0, 1.0), e.kind == 9u);
  let faded = select(1.0, 0.22, e.kind == 8u && e.shieldT > 0.5);
  o.col = vec4f(col, faded);
  o.misc = vec4f(rad, hpf, select(0.0, 1.0, e.maxhp >= 80.0), shieldFrac);
  return o;
}

@fragment
fn fsEnemy(i: EOut) -> @location(0) vec4f {
  let rad = i.misc.x;
  let d = length(i.uv) - rad;
  var a = 1.0 - smoothstep(-V.aa, V.aa, d);
  var col = i.col.rgb;
  let ow = select(1.6, 3.4, rad >= 11.0);
  col = mix(col, col * 0.42, smoothstep(-ow, -ow + 1.0, d));
  if (i.misc.w > 0.02) {
    let ring = (1.0 - smoothstep(-V.aa, V.aa, abs(d - 2.2) - 0.9)) * (0.35 + 0.65 * i.misc.w);
    col = mix(col, vec3f(0.55, 0.95, 1.0), ring);
    a = max(a, ring * 0.9);
  }
  if (i.misc.z > 0.5 && i.misc.y < 0.999) {
    let by = -(rad + 6.0);
    let w = max(rad, 7.0) * 1.1;
    let inBar = step(abs(i.uv.x), w) * step(abs(i.uv.y - by), 1.4);
    let fill = step(i.uv.x, -w + 2.0 * w * i.misc.y);
    let bar = mix(vec3f(0.16, 0.2, 0.26), vec3f(0.37, 0.92, 0.83), fill);
    col = mix(col, bar, inBar);
    a = max(a, inBar);
  }
  a = a * i.col.a;
  return vec4f(col * a, a);
}

struct TOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) idx: u32,
};

@vertex
fn vsTower(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> TOut {
  var o: TOut;
  o.idx = ii;
  let c = tc[ii];
  if (c.live == 0u) { o.pos = vec4f(3.0, 3.0, 0.0, 1.0); return o; }
  let cr = CORNERS[vi] * 30.0;
  o.pos = toClip(c.pos + cr);
  o.uv = cr;
  return o;
}

fn sdBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fsTower(i: TOut) -> @location(0) vec4f {
  let c = tc[i.idx];
  let s = ts[i.idx];
  let col = vec3f(c.cr, c.cg, c.cb) * select(1.0, 0.32, c.live == 2u);
  var aim = s.aim;
  if (dot(aim, aim) < 0.5) { aim = vec2f(1.0, 0.0); }
  let p = i.uv;
  let lp = vec2f(dot(p, aim), dot(p, vec2f(-aim.y, aim.x)));
  let bg = vec3f(0.07, 0.094, 0.125);

  var body: f32;
  if (c.kind == 3u) { body = sdBox(p, vec2f(14.0), 4.0); } else if (c.kind == 1u) { body = (abs(p.x) + abs(p.y)) * 0.7071 - 15.5; } else { body = length(p) - 15.0; }
  var barrel = 1e3;
  if (c.kind == 0u) { barrel = sdBox(lp - vec2f(9.0, 0.0), vec2f(10.0, 2.4), 1.0); }
  if (c.kind == 1u) { barrel = sdBox(lp - vec2f(8.0, 0.0), vec2f(8.0, 1.3), 0.6); }
  if (c.kind == 2u) { barrel = sdBox(lp - vec2f(8.0, 0.0), vec2f(8.0, 4.4), 2.0); }
  if (c.kind == 3u) { barrel = length(lp) - 5.5; }

  let aaw = V.aa;
  let aBody = 1.0 - smoothstep(-aaw, aaw, body);
  var rgb = bg;
  let ring = smoothstep(-3.0, -2.2, body);
  rgb = mix(rgb, col, ring);
  let aBar = 1.0 - smoothstep(-aaw, aaw, barrel);
  rgb = mix(rgb, col, aBar);
  var alpha = aBody;

  // level pips below the tower
  for (var k = 0u; k <= c.level; k++) {
    let pc = vec2f((f32(k) - f32(c.level) * 0.5) * 7.0, 22.0);
    let pd = length(p - pc) - 2.1;
    let pa = 1.0 - smoothstep(-aaw, aaw, pd);
    rgb = mix(rgb, col, pa);
    alpha = max(alpha, pa);
  }
  return vec4f(rgb * alpha, alpha);
}

struct FOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec2f,
  @location(1) @interpolate(flat) idx: u32,
};

@vertex
fn vsFx(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FOut {
  var o: FOut;
  o.idx = ii;
  let c = tc[ii];
  let s = ts[ii];
  if (c.live == 0u) { o.pos = vec4f(3.0, 3.0, 0.0, 1.0); return o; }
  var lo = c.pos; var hi = c.pos; var m = 0.0; var act = false;
  if (c.kind == 0u && s.fire > 0.01) { lo = min(c.pos, s.tgt); hi = max(c.pos, s.tgt); m = 8.0; act = true; }
  if (c.kind == 1u && s.fire > 0.01) { let e = c.pos + s.aim * c.range; lo = min(c.pos, e); hi = max(c.pos, e); m = c.radius * 3.0 + 6.0; act = true; }
  if (c.kind == 2u && s.fire > 0.01) { lo = c.pos - vec2f(c.range); hi = c.pos + vec2f(c.range); m = 6.0; act = true; }
  if (c.kind == 3u && (s.shellT > 0.0 || s.boom > 0.01)) {
    lo = c.pos; hi = c.pos;
    if (s.shellT > 0.0) { lo = min(lo, s.shellTo); hi = max(hi, s.shellTo); }
    if (s.boom > 0.01) { lo = min(lo, s.boomPos); hi = max(hi, s.boomPos); }
    m = c.radius + 30.0; act = true;
  }
  if (!act) { o.pos = vec4f(3.0, 3.0, 0.0, 1.0); return o; }
  lo -= vec2f(m); hi += vec2f(m);
  let cn = CORNERS[vi] * 0.5 + vec2f(0.5);
  o.wp = mix(lo, hi, cn);
  o.pos = toClip(o.wp);
  return o;
}

fn disc(p: vec2f, c: vec2f, r: f32) -> f32 { return 1.0 - smoothstep(-V.aa, V.aa, distance(p, c) - r); }

@fragment
fn fsFx(i: FOut) -> @location(0) vec4f {
  let c = tc[i.idx];
  let s = ts[i.idx];
  let col = vec3f(c.cr, c.cg, c.cb);
  let p = i.wp;
  var rgb = vec3f(0.0);
  var a = 0.0;

  if (c.kind == 0u) {
    let a0 = c.pos + s.aim * 16.0;
    let sd = segDist(p, a0, s.tgt);
    let line = 1.0 - smoothstep(0.5, 0.5 + max(V.aa, 1.0), sd.x - 0.6);
    let hit = disc(p, s.tgt, select(4.5, 0.0, c.pierce > 0.0) * s.fire);
    rgb = mix(col, vec3f(1.0), 0.4);
    a = max(line * 0.9, hit * 0.8) * s.fire;
  } else if (c.kind == 1u) {
    let b = c.pos + s.aim * c.range;
    let sd = segDist(p, c.pos + s.aim * 14.0, b);
    let dashes = mix(0.5, 1.0, smoothstep(0.35, 0.55, fract(sd.y / 16.0 - V.time * 7.0)));
    let core = (1.0 - smoothstep(0.6, 1.4 + V.aa, sd.x)) ;
    let glow = exp(-sd.x / (c.radius * 0.9));
    rgb = mix(col, vec3f(1.0), core * 0.8);
    a = clamp(core + glow * 0.35, 0.0, 1.0) * dashes * s.fire * (1.0 - 0.5 * sd.y / c.range);
  } else if (c.kind == 2u) {
    let rel = p - c.pos;
    let d = length(rel);
    let cs = dot(rel / max(d, 0.001), s.aim);
    let t = clamp(d / c.range, 0.0, 1.0);
    let cone = smoothstep(c.radius - 0.02, c.radius + 0.1, cs);
    let flick = 0.72 + 0.28 * sin(d * 0.45 - V.time * 28.0 + rel.x * 0.31 + rel.y * 0.23);
    let k = cone * pow(1.0 - t, 0.8) * flick * smoothstep(8.0, 18.0, d);
    rgb = mix(vec3f(1.0, 0.92, 0.55), mix(vec3f(1.0, 0.45, 0.1), vec3f(0.75, 0.12, 0.08), t), smoothstep(0.0, 0.5, t));
    a = k * 0.8 * s.fire;
  } else {
    if (s.shellT > 0.0) {
      let tt = 1.0 - s.shellT / c.flight;
      let span = distance(c.pos, s.shellTo);
      let pos = mix(c.pos, s.shellTo, tt) - vec2f(0.0, sin(tt * 3.14159) * span * 0.28);
      let ground = mix(c.pos, s.shellTo, tt);
      let sh = disc(p, ground, 3.0) * 0.25;
      let ball = disc(p, pos, 3.2 + 2.0 * sin(tt * 3.14159));
      let mark = abs(distance(p, s.shellTo) - c.radius) - 0.7;
      let ringA = (1.0 - smoothstep(-V.aa, V.aa, mark)) * 0.28;
      rgb = col; a = max(max(ball, sh), ringA);
    }
    if (s.boom > 0.01) {
      let r = c.radius * (1.12 - 0.55 * s.boom);
      let d = distance(p, s.boomPos);
      let fill = (1.0 - smoothstep(r - 2.0, r, d)) * s.boom * 0.45;
      let ring = (1.0 - smoothstep(-V.aa, V.aa, abs(d - r) - 1.8)) * s.boom;
      let b = max(fill, ring);
      rgb = mix(rgb, mix(col, vec3f(1.0), ring * 0.5), step(a, b));
      a = max(a, b);
    }
  }
  return vec4f(rgb * a, a);
}
`;

function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(4)).join(',');
}

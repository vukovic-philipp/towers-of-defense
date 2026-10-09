// Headless game simulation (no DOM): waves, economy, towers and weapon impulses on top of BallWorld.
import {
  GOBLINS, TOWERS, MAX_LEVEL, upgradeCost, SELL_RATIO, PRICE_CREEP, TOWER_SPACING, START_GOLD,
  waveList, waveHp, waveBounty, mulberry32,
} from './data.js';
import { BallWorld, buildCave } from './physics.js';

const MAXE = 1024;
const MAX_FX = 160;
const FIRST_WAVE_DELAY = 15, WAVE_GAP = 10;

export class Game {
  /** dims = { w, h }: simulation frame (gravity along +y). Screen shows it transposed (flow left to right). */
  constructor(mods, seed = 1, dims = { w: 440, h: 620 }) {
    this.mods = mods;
    this.W = dims.w; this.H = dims.h;
    this.rng = mulberry32(seed);
    this.cave = buildCave(seed, this.W, this.H);
    this.leakY = this.cave.leak;
    this.w = new BallWorld(this.cave, MAXE);
    this.w.rs = (seed * 2654435761 | 0) || 1;
    // typed arrays are shared with the physics world
    this.x = this.w.x; this.y = this.w.y; this.vx = this.w.vx; this.vy = this.w.vy;
    this.slowT = this.w.slowT; this.slowF = this.w.slowF;
    this.hp = new Float32Array(MAXE); this.maxhp = new Float32Array(MAXE); this.type = new Uint8Array(MAXE);

    this.gold = START_GOLD + mods.startGold;
    this.lives = 20 + mods.lives;
    this.wave = 0; this.kills = 0; this.time = 0;
    this.over = false; this.reviveUsed = false;
    this.towers = [];
    this.events = [];
    this.fx = [];

    this.queue = null; this.qi = 0; this.spawnT = 0; this.spawnGap = 1;
    this.spawning = false; this.countdown = FIRST_WAVE_DELAY; this.clearPaid = true;
    this.waveHpNow = 0;
  }
  get n() { return this.w.n; }

  // ---------- building (free placement) ----------
  isUnlocked(type) { return !!this.mods.unlocked[type]; }
  towerCost(type) { return Math.round(TOWERS[type].cost * (1 + PRICE_CREEP * this.towers.length)); }
  towerAt(x, y, radius = 18) {
    let best = null, bd = radius * radius;
    for (const t of this.towers) { const d = (t.x - x) ** 2 + (t.y - y) ** 2; if (d <= bd) { bd = d; best = t; } }
    return best;
  }
  canPlace(x, y) {
    if (x < 8 || x > this.W - 8 || y < 8 || y > this.leakY - 14) return false;
    for (const t of this.towers) if ((t.x - x) ** 2 + (t.y - y) ** 2 < TOWER_SPACING * TOWER_SPACING) return false;
    return true;
  }
  build(type, x, y) {
    const def = TOWERS[type];
    if (this.over || !def || !this.isUnlocked(type) || !this.canPlace(x, y)) return null;
    const cost = this.towerCost(type);
    if (this.gold < cost) return null;
    this.gold -= cost;
    const t = { type, x, y, lvl: 1, spent: cost, cd: 0, mode: 0, ang: -Math.PI / 2 };
    this.applyStats(t);
    this.towers.push(t);
    return t;
  }
  applyStats(t) {
    const d = TOWERS[t.type], m = this.mods, l = t.lvl - 1;
    t.dmg = d.dmg * Math.pow(1.55, l) * m.dmg;
    t.range = d.range * (1 + 0.04 * l) * m.range;
    t.rate = d.rate * (1 + 0.05 * l) * m.rate;
    t.splash = (d.splash || 0) * m.splash * (1 + 0.05 * l);
    t.slow = d.slow ? Math.min(0.65, d.slow + 0.05 * l) : 0;
    t.chain = d.chain ? d.chain + (l >> 1) : 0;
  }
  nextUpgradeCost(t) { return t.lvl >= MAX_LEVEL ? null : upgradeCost(t.type, t.lvl); }
  upgrade(t) {
    const cost = this.nextUpgradeCost(t);
    if (this.over || cost === null || this.gold < cost) return false;
    this.gold -= cost; t.spent += cost; t.lvl++;
    this.applyStats(t);
    return true;
  }
  sellValue(t) { return Math.floor(t.spent * SELL_RATIO); }
  sell(t) {
    const i = this.towers.indexOf(t);
    if (i < 0 || this.over) return false;
    this.gold += this.sellValue(t);
    this.towers.splice(i, 1);
    return true;
  }

  // ---------- waves ----------
  skipCountdown() {
    if (this.spawning || this.over) return false;
    this.gold += Math.ceil(this.countdown);
    this.countdown = 0;
    return true;
  }
  startWave() {
    this.wave++;
    this.queue = waveList(this.wave); this.qi = 0; this.spawnT = 0;
    this.spawnGap = Math.max(0.12, Math.min(0.9, 40 / this.queue.length));
    this.waveHpNow = waveHp(this.wave);
    this.spawning = true; this.clearPaid = false;
    const m = this.mods;
    if (m.interest > 0) this.gold += Math.min(Math.floor(this.gold * m.interest), 40 + 10 * this.wave);
    this.events.push('wave');
  }
  spawn(type) {
    const g = GOBLINS[type];
    const i = this.w.add(g.r + 3 + this.rng() * (this.W - 2 * g.r - 6), -g.r - 2, g.r, g.drag, 25);
    if (i < 0) return false;
    this.type[i] = type;
    this.hp[i] = this.maxhp[i] = this.waveHpNow * g.hp;
    return true;
  }

  // ---------- main step ----------
  update(dt) {
    if (this.over) return;
    this.time += dt;

    if (this.spawning) {
      this.spawnT -= dt;
      while (this.spawnT <= 0 && this.qi < this.queue.length) {
        if (!this.spawn(this.queue[this.qi])) break;
        this.qi++; this.spawnT += this.spawnGap;
      }
      if (this.qi >= this.queue.length) { this.spawning = false; this.countdown = WAVE_GAP; }
    } else {
      this.countdown -= dt;
      if (this.countdown <= 0) this.startWave();
    }
    if (!this.spawning && !this.clearPaid && this.n === 0 && this.wave > 0) {
      this.clearPaid = true;
      this.gold += Math.round((8 + 1.5 * this.wave) * this.mods.bounty);
      this.events.push('clear');
    }

    this.w.step(dt);
    for (let i = 0; i < this.n; i++) {
      if (this.y[i] >= this.leakY && this.hp[i] > 0) {
        this.lives -= GOBLINS[this.type[i]].leak; this.hp[i] = 0; this.events.push('leak');
      }
    }
    this.fireTowers(dt);
    this.reap();
    this.updateFx(dt);

    if (this.lives <= 0) {
      if (this.mods.revive && !this.reviveUsed) {
        this.reviveUsed = true; this.lives = 10; this.events.push('revive');
      } else { this.lives = 0; this.over = true; this.events.push('over'); }
    }
  }

  hit(i, d) { this.hp[i] -= d; }
  roll(t) { return this.mods.crit > 0 && this.rng() < this.mods.crit ? t.dmg * 2 : t.dmg; }

  pickTarget(t) {
    const { n, x, y, hp, maxhp } = this;
    const r2 = t.range * t.range;
    let best = -1, bv = -Infinity;
    for (let i = 0; i < n; i++) {
      if (hp[i] <= 0) continue;
      const dx = x[i] - t.x, dy = y[i] - t.y, d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const v = t.mode === 0 ? y[i] : t.mode === 1 ? maxhp[i] * 1e4 + hp[i] : -d2;
      if (v > bv) { bv = v; best = i; }
    }
    return best;
  }

  addFx(f) { if (this.fx.length < MAX_FX) this.fx.push(f); }

  fireTowers(dt) {
    if (this.n === 0) { for (const t of this.towers) t.cd = Math.max(0, t.cd - dt); return; }
    const { x, y, hp, w } = this;
    for (const t of this.towers) {
      t.cd -= dt;
      if (t.cd > 0) continue;
      if (t.type === 'frost') { this.fireFrost(t); continue; }
      const i = this.pickTarget(t);
      if (i < 0) { t.cd = 0; continue; }
      t.cd += 1 / t.rate;
      if (t.cd < 0) t.cd = 0;
      const dx = x[i] - t.x, dy = y[i] - t.y;
      t.ang = Math.atan2(dy, dx);
      const dmg = this.roll(t);
      if (t.type === 'arrow') {
        this.hit(i, dmg);
        const L = Math.hypot(dx, dy) || 1;
        w.push(i, dx / L * TOWERS.arrow.push, dy / L * TOWERS.arrow.push);
        this.addFx({ k: 'line', x1: t.x, y1: t.y, x2: x[i], y2: y[i], age: 0, life: 0.09, c: '#fff1c1' });
      } else if (t.type === 'cannon') {
        const ex = x[i], ey = y[i], R = t.splash, blast = TOWERS.cannon.blast;
        for (let j = 0; j < this.n; j++) {
          if (hp[j] <= 0) continue;
          const ddx = x[j] - ex, ddy = y[j] - ey, d2 = ddx * ddx + ddy * ddy;
          if (d2 > R * R) continue;
          const d = Math.sqrt(d2), fall = 1 - d / R;
          this.hit(j, j === i ? dmg : dmg * 0.6);
          // radial blast, biased upward so balls get tossed back up the cave
          const L = d || 1;
          w.push(j, ddx / L * blast * fall, ddy / L * blast * fall - 70 * fall);
        }
        this.addFx({ k: 'line', x1: t.x, y1: t.y, x2: ex, y2: ey, age: 0, life: 0.07, c: '#ddd' });
        this.addFx({ k: 'ring', x: ex, y: ey, r: R, age: 0, life: 0.25, c: '#ff9f43' });
      } else if (t.type === 'tesla') {
        this.fireTesla(t, i, dmg);
      }
    }
  }

  fireFrost(t) {
    const { x, y, hp, n } = this, r2 = t.range * t.range;
    let any = false;
    for (let j = 0; j < n; j++) {
      if (hp[j] <= 0) continue;
      const dx = x[j] - t.x, dy = y[j] - t.y;
      if (dx * dx + dy * dy > r2) continue;
      any = true;
      this.hit(j, t.dmg);
      const f = 1 - (this.type[j] === 3 ? t.slow * 0.5 : t.slow);
      if (this.slowT[j] <= 0 || f < this.slowF[j]) this.slowF[j] = f;
      this.slowT[j] = 1.6;
    }
    if (any) {
      t.cd += 1 / t.rate; if (t.cd < 0) t.cd = 0;
      this.addFx({ k: 'ring', x: t.x, y: t.y, r: t.range, age: 0, life: 0.35, c: '#aee6ff', grow: true });
    } else t.cd = 0;
  }

  fireTesla(t, first, dmg) {
    const { x, y, hp, n, w } = this;
    const pts = [t.x, t.y, x[first], y[first]];
    const hitSet = [first];
    this.hit(first, dmg);
    let cur = first;
    for (let k = 0; k < t.chain; k++) {
      let best = -1, bd = 60 * 60;
      for (let j = 0; j < n; j++) {
        if (hp[j] <= 0 || hitSet.includes(j)) continue;
        const dx = x[j] - x[cur], dy = y[j] - y[cur], d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = j; }
      }
      if (best < 0) break;
      hitSet.push(best); this.hit(best, dmg * 0.8);
      pts.push(x[best], y[best]); cur = best;
    }
    for (const j of hitSet) w.push(j, (this.rng() - 0.5) * 90, (this.rng() - 0.5) * 90 - 20); // electric jolt
    this.addFx({ k: 'bolt', pts, age: 0, life: 0.12, c: '#fff6a0' });
  }

  /** Remove dead balls (swap-remove), pay bounties for kills (not for leaks). */
  reap() {
    const { hp, y, type, leakY } = this;
    for (let i = this.n - 1; i >= 0; i--) {
      if (hp[i] > 0) continue;
      if (y[i] < leakY) {
        const g = GOBLINS[type[i]];
        this.gold += Math.max(1, Math.round(g.bounty * waveBounty(this.wave) * this.mods.bounty));
        this.kills++;
      }
      const last = --this.w.n;
      if (i !== last) { this.w.copy(last, i); this.hp[i] = this.hp[last]; this.maxhp[i] = this.maxhp[last]; this.type[i] = this.type[last]; }
    }
  }
  updateFx(dt) {
    const fx = this.fx;
    let k = 0;
    for (let i = 0; i < fx.length; i++) {
      fx[i].age += dt;
      if (fx[i].age < fx[i].life) fx[k++] = fx[i];
    }
    fx.length = k;
  }

  /** Shards awarded for this run. */
  shards() { return Math.floor(this.wave * 2 + Math.pow(this.wave, 1.5) * 0.5 + this.kills / 20); }
}

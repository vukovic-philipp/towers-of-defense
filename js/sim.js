// Headless game simulation. No DOM access, so it can be tested under Node.
// Enemies are stored struct-of-arrays in typed arrays; dead ones are swap-removed.
import {
  COLS, ROWS, TILE, PATH_LEN, PATH_CELLS, SEG_N, SEG_X0, SEG_Y0, SEG_DX, SEG_DY, SEG_START,
  GOBLINS, BASE_SPEED, TOWERS, MAX_LEVEL, upgradeCost, SELL_RATIO,
  waveList, waveHp, waveBounty,
} from './data.js';

const MAXE = 1024;
const MAX_FX = 160;
const FIRST_WAVE_DELAY = 15, WAVE_GAP = 10;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class Game {
  constructor(mods, seed = 1) {
    this.mods = mods;
    this.rng = mulberry32(seed);
    this.gold = 100 + mods.startGold;
    this.lives = 20 + mods.lives;
    this.wave = 0; this.kills = 0; this.time = 0;
    this.over = false; this.reviveUsed = false;
    this.towers = [];
    this.cells = new Array(COLS * ROWS).fill(null);
    this.events = [];
    this.fx = [];

    this.n = 0;
    this.x = new Float32Array(MAXE); this.y = new Float32Array(MAXE);
    this.dist = new Float32Array(MAXE);
    this.hp = new Float32Array(MAXE); this.maxhp = new Float32Array(MAXE);
    this.spd = new Float32Array(MAXE);
    this.slowT = new Float32Array(MAXE); this.slowF = new Float32Array(MAXE);
    this.off = new Float32Array(MAXE);
    this.type = new Uint8Array(MAXE); this.seg = new Uint8Array(MAXE);

    this.queue = null; this.qi = 0; this.spawnT = 0; this.spawnGap = 1;
    this.spawning = false; this.countdown = FIRST_WAVE_DELAY; this.clearPaid = true;
    this.waveHpNow = 0;
  }

  // ---------- building ----------
  isUnlocked(type) { return !!this.mods.unlocked[type]; }
  canPlace(c, r) {
    return c >= 0 && c < COLS && r >= 0 && r < ROWS && !PATH_CELLS[r * COLS + c] && !this.cells[r * COLS + c];
  }
  build(type, c, r) {
    const def = TOWERS[type];
    if (this.over || !def || !this.isUnlocked(type) || !this.canPlace(c, r) || this.gold < def.cost) return null;
    this.gold -= def.cost;
    const t = { type, c, r, x: (c + 0.5) * TILE, y: (r + 0.5) * TILE, lvl: 1, spent: def.cost, cd: 0, mode: 0, ang: -Math.PI / 2 };
    this.applyStats(t);
    this.towers.push(t);
    this.cells[r * COLS + c] = t;
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
    this.cells[t.r * COLS + t.c] = null;
    return true;
  }

  // ---------- waves ----------
  skipCountdown() {
    if (this.spawning || this.over) return false;
    this.gold += Math.ceil(this.countdown) * 2;
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
    if (this.n >= MAXE) return false;
    const i = this.n++, g = GOBLINS[type];
    this.type[i] = type;
    this.hp[i] = this.maxhp[i] = this.waveHpNow * g.hp;
    this.spd[i] = BASE_SPEED * g.speed;
    this.dist[i] = 0; this.seg[i] = 0;
    this.slowT[i] = 0; this.slowF[i] = 1;
    this.off[i] = (this.rng() - 0.5) * 18;
    this.x[i] = SEG_X0[0]; this.y[i] = SEG_Y0[0] + this.off[i];
    return true;
  }

  // ---------- main step ----------
  update(dt) {
    if (this.over) return;
    this.time += dt;

    // wave control
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
      this.gold += Math.round((10 + 2 * this.wave) * this.mods.bounty);
      this.events.push('clear');
    }

    this.moveEnemies(dt);
    this.fireTowers(dt);
    this.reap();
    this.updateFx(dt);

    if (this.lives <= 0) {
      if (this.mods.revive && !this.reviveUsed) {
        this.reviveUsed = true; this.lives = 10; this.events.push('revive');
      } else { this.lives = 0; this.over = true; this.events.push('over'); }
    }
  }

  moveEnemies(dt) {
    const { n, dist, spd, slowT, slowF, hp, seg, x, y, off, type } = this;
    for (let i = 0; i < n; i++) {
      let f = 1;
      if (slowT[i] > 0) { slowT[i] -= dt; f = slowF[i]; }
      const d = dist[i] += spd[i] * f * dt;
      if (d >= PATH_LEN) {
        this.lives -= GOBLINS[type[i]].leak; hp[i] = 0; this.events.push('leak');
        continue;
      }
      let s = seg[i];
      while (s < SEG_N - 1 && d >= SEG_START[s + 1]) s++;
      seg[i] = s;
      const o = d - SEG_START[s];
      x[i] = SEG_X0[s] + SEG_DX[s] * o - SEG_DY[s] * off[i];
      y[i] = SEG_Y0[s] + SEG_DY[s] * o + SEG_DX[s] * off[i];
    }
  }

  hit(i, d) { this.hp[i] -= d; }
  roll(t) { return this.mods.crit > 0 && this.rng() < this.mods.crit ? t.dmg * 2 : t.dmg; }

  pickTarget(t) {
    const { n, x, y, hp, dist, maxhp } = this;
    const r2 = t.range * t.range;
    let best = -1, bv = -Infinity;
    for (let i = 0; i < n; i++) {
      if (hp[i] <= 0) continue;
      const dx = x[i] - t.x, dy = y[i] - t.y, d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const v = t.mode === 0 ? dist[i] : t.mode === 1 ? maxhp[i] * 1e4 + hp[i] : -d2;
      if (v > bv) { bv = v; best = i; }
    }
    return best;
  }

  addFx(f) { if (this.fx.length < MAX_FX) this.fx.push(f); }

  fireTowers(dt) {
    if (this.n === 0) { for (const t of this.towers) t.cd = Math.max(0, t.cd - dt); return; }
    const { x, y, hp } = this;
    for (const t of this.towers) {
      t.cd -= dt;
      if (t.cd > 0) continue;
      if (t.type === 'frost') { this.fireFrost(t); continue; }
      const i = this.pickTarget(t);
      if (i < 0) { t.cd = 0; continue; }
      t.cd += 1 / t.rate;
      if (t.cd < 0) t.cd = 0;
      t.ang = Math.atan2(y[i] - t.y, x[i] - t.x);
      const dmg = this.roll(t);
      if (t.type === 'arrow') {
        this.hit(i, dmg);
        this.addFx({ k: 'line', x1: t.x, y1: t.y, x2: x[i], y2: y[i], age: 0, life: 0.09, c: '#fff1c1' });
      } else if (t.type === 'cannon') {
        const ex = x[i], ey = y[i], r2 = t.splash * t.splash;
        for (let j = 0; j < this.n; j++) {
          if (hp[j] <= 0) continue;
          const dx = x[j] - ex, dy = y[j] - ey;
          if (dx * dx + dy * dy <= r2) this.hit(j, j === i ? dmg : dmg * 0.6);
        }
        this.addFx({ k: 'line', x1: t.x, y1: t.y, x2: ex, y2: ey, age: 0, life: 0.07, c: '#ddd' });
        this.addFx({ k: 'ring', x: ex, y: ey, r: t.splash, age: 0, life: 0.25, c: '#ff9f43' });
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
    const { x, y, hp, n } = this;
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
    this.addFx({ k: 'bolt', pts, age: 0, life: 0.12, c: '#fff6a0' });
  }

  /** Remove dead enemies (swap-remove), pay bounties for kills. */
  reap() {
    const { hp, dist, type } = this;
    for (let i = this.n - 1; i >= 0; i--) {
      if (hp[i] > 0) continue;
      if (dist[i] < PATH_LEN) {
        const g = GOBLINS[type[i]];
        this.gold += Math.max(1, Math.round(g.bounty * waveBounty(this.wave) * this.mods.bounty));
        this.kills++;
      }
      const last = --this.n;
      if (i !== last) this.copyEnemy(last, i);
    }
  }
  copyEnemy(from, to) {
    this.x[to] = this.x[from]; this.y[to] = this.y[from]; this.dist[to] = this.dist[from];
    this.hp[to] = this.hp[from]; this.maxhp[to] = this.maxhp[from]; this.spd[to] = this.spd[from];
    this.slowT[to] = this.slowT[from]; this.slowF[to] = this.slowF[from]; this.off[to] = this.off[from];
    this.type[to] = this.type[from]; this.seg[to] = this.seg[from];
  }
  updateFx(dt) {
    const fx = this.fx;
    let w = 0;
    for (let i = 0; i < fx.length; i++) {
      fx[i].age += dt;
      if (fx[i].age < fx[i].life) fx[w++] = fx[i];
    }
    fx.length = w;
  }

  /** Shards awarded for this run. */
  shards() { return Math.floor(this.wave * 2 + Math.pow(this.wave, 1.5) * 0.5 + this.kills / 20); }
}

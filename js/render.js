// Canvas renderer.
// The simulation has gravity along +y; here x/y are transposed (screen X = sim y, screen Y = sim x) so that the
// balls flow from left to right. The world is fitted into the canvas, centred. Drawing uses screen-aligned axes
// (no rotated transforms) so blits stay on the fast path.
import { GOBLINS, TOWERS } from './data.js';

const C = {
  bg: '#0a0d12', spawn: 'rgba(94,234,212,0.10)', rock: '#1a212a', rockEdge: '#364251',
  wall: '#27313d', castle: '#18222d', accent: '#5eead4', tower: '#0e1116',
};

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.pr = 1; this.cssW = 1; this.cssH = 1;
    this.view = { s: 1, ox: 0, oy: 0 };
    this.bg = null; this.caveRef = null;
  }

  resize(cssW, cssH) {
    this.pr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = cssW; this.cssH = cssH;
    this.cv.width = Math.round(cssW * this.pr); this.cv.height = Math.round(cssH * this.pr);
    this.bg = null;
    this.buildSprites();
  }

  /** Device-pixel scale and offset that fit the sim world (W x H, transposed) into the canvas. */
  fit(cave) {
    const cw = this.cv.width, ch = this.cv.height;
    const s = Math.min(cw / cave.H, ch / cave.W);
    this.view = { s, ox: (cw - cave.H * s) / 2, oy: (ch - cave.W * s) / 2 };
    return this.view;
  }

  /** Client (CSS) pixel position -> sim coordinates. */
  toWorld(clientX, clientY, cave) {
    const r = this.cv.getBoundingClientRect(), { s, ox, oy } = this.fit(cave);
    const X = (clientX - r.left) / r.width * this.cv.width, Y = (clientY - r.top) / r.height * this.cv.height;
    return { x: (Y - oy) / s, y: (X - ox) / s };
  }

  makeCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h);
    return [c, c.getContext('2d')];
  }

  buildBackground(cave) {
    const { s } = this.fit(cave), { W, H } = cave;
    const [c, x] = this.makeCanvas(H * s, W * s);      // stored in screen orientation: sim (x, y) -> (y, x)
    x.setTransform(0, s, s, 0, 0, 0);
    x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
    const g = x.createLinearGradient(0, 0, 0, 90);          // spawn glow (left on screen)
    g.addColorStop(0, C.spawn); g.addColorStop(1, 'rgba(94,234,212,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, 90);
    x.fillStyle = C.castle; x.fillRect(0, cave.leak, W, H - cave.leak);   // castle (right on screen)
    x.fillStyle = C.accent; x.globalAlpha = 0.55; x.fillRect(0, cave.leak - 1, W, 2); x.globalAlpha = 1;
    x.lineJoin = 'round';
    for (const p of cave.rocks) {
      x.beginPath(); x.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]);
      x.closePath();
      x.fillStyle = C.rock; x.fill();
      x.lineWidth = 1.5; x.strokeStyle = C.rockEdge; x.stroke();
    }
    x.fillStyle = C.wall; x.fillRect(0, 0, 2, H); x.fillRect(W - 2, 0, 2, H);
    this.bg = c; this.caveRef = cave;
  }

  buildSprites() {
    const s = this.pr * 3;   // sprites are rendered at 3x per css px so they stay crisp at any fit scale
    this.sprites = GOBLINS.map(g => {
      const d = g.r * 2 + 4;
      const [c, x] = this.makeCanvas(d * s, d * s);
      x.scale(s, s); x.translate(d / 2, d / 2);
      x.fillStyle = g.color; x.beginPath(); x.arc(0, 0, g.r, 0, 7); x.fill();
      x.lineWidth = 1.5; x.strokeStyle = 'rgba(0,0,0,0.5)'; x.stroke();
      return { c, d };
    });
  }

  /** All drawing happens in screen-aligned axes: u = sim y (horizontal), v = sim x (vertical). */
  draw(game, ui) {
    const ctx = this.ctx, cave = game.cave;
    if (!this.bg || this.caveRef !== cave) this.buildBackground(cave);
    const { s, ox, oy } = this.fit(cave);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (ox > 1 || oy > 1) { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, this.cv.width, this.cv.height); }
    ctx.drawImage(this.bg, Math.round(ox), Math.round(oy));
    ctx.setTransform(s, 0, 0, s, ox, oy);

    if (ui.selPoint) {
      const u = ui.selPoint.y, v = ui.selPoint.x;
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(u, v, 13, 0, 7);
      ctx.moveTo(u - 20, v); ctx.lineTo(u - 8, v); ctx.moveTo(u + 8, v); ctx.lineTo(u + 20, v);
      ctx.moveTo(u, v - 20); ctx.lineTo(u, v - 8); ctx.moveTo(u, v + 8); ctx.lineTo(u, v + 20); ctx.stroke();
    }
    if (ui.selTower) {
      const t = ui.selTower;
      ctx.fillStyle = 'rgba(94,234,212,0.07)'; ctx.strokeStyle = 'rgba(94,234,212,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(t.y, t.x, t.range, 0, 7); ctx.fill(); ctx.stroke();
    }

    // balls
    const { n, x, y, hp, maxhp, type, slowT } = game;
    for (let i = 0; i < n; i++) {
      const sp = this.sprites[type[i]], f = hp[i] / maxhp[i];
      ctx.globalAlpha = f > 0.99 ? 1 : 0.4 + 0.6 * Math.max(0, f);   // damaged balls fade
      ctx.drawImage(sp.c, y[i] - sp.d / 2, x[i] - sp.d / 2, sp.d, sp.d);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#8fd3ff'; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let i = 0; i < n; i++) if (slowT[i] > 0) { const r = GOBLINS[type[i]].r + 2; ctx.moveTo(y[i] + r, x[i]); ctx.arc(y[i], x[i], r, 0, 6.3); }
    ctx.stroke();

    for (const f of game.fx) {
      const a = 1 - f.age / f.life;
      ctx.globalAlpha = Math.max(0, a); ctx.strokeStyle = f.c;
      if (f.k === 'line') {
        ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(f.y1, f.x1); ctx.lineTo(f.y2, f.x2); ctx.stroke();
      } else if (f.k === 'ring') {
        const r = f.grow ? f.r * (1 - a * 0.8) : f.r * (0.4 + 0.6 * (1 - a));
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(f.y, f.x, r, 0, 7); ctx.stroke();
        if (!f.grow) { ctx.fillStyle = f.c; ctx.globalAlpha = a * 0.18; ctx.fill(); }
      } else if (f.k === 'bolt') {
        const p = f.pts;
        ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p[1], p[0]);
        for (let j = 2; j < p.length; j += 2) {
          ctx.lineTo((p[j - 1] + p[j + 1]) / 2 + (Math.random() - 0.5) * 8, (p[j - 2] + p[j]) / 2 + (Math.random() - 0.5) * 8);
          ctx.lineTo(p[j + 1], p[j]);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    for (const t of game.towers) this.drawTower(ctx, t);
    for (let i = 0; i < n; i++) if (type[i] === 3 && hp[i] > 0) {
      const u = y[i], v = x[i];
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(u - 15, v - 22, 30, 4);
      ctx.fillStyle = '#ef6a6a'; ctx.fillRect(u - 14, v - 21, 28 * hp[i] / maxhp[i], 2);
    }

    if (ui.paused) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(10,13,18,0.6)'; ctx.fillRect(0, 0, this.cv.width, this.cv.height);
      ctx.fillStyle = '#e6edf3'; ctx.font = `600 ${28 * this.pr}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Paused', this.cv.width / 2, this.cv.height / 2);
    }
  }

  drawTower(ctx, t) {
    const def = TOWERS[t.type], u = t.y, v = t.x, a = Math.PI / 2 - t.ang;   // a = aim angle in screen axes
    ctx.fillStyle = C.tower; ctx.strokeStyle = def.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(u, v, 12, 0, 7); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.translate(u, v); ctx.rotate(a);
    ctx.fillStyle = def.color; ctx.strokeStyle = def.color;
    if (t.type === 'arrow') ctx.fillRect(0, -1.5, 15, 3);
    else if (t.type === 'cannon') ctx.fillRect(0, -3.5, 15, 7);
    else { ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.fill(); }
    ctx.restore();
    ctx.fillStyle = def.color;
    for (let i = 0; i < t.lvl; i++) { ctx.beginPath(); ctx.arc(u - (t.lvl - 1) * 2.5 + i * 5, v + 17, 1.6, 0, 7); ctx.fill(); }
  }
}

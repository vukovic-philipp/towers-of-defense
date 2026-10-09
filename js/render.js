// Canvas renderer. The cave and ball sprites are pre-rendered once per resize.
import { W, H, GOBLINS, TOWERS } from './data.js';
import { LEAK_Y } from './physics.js';

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.k = 1; this.caveRef = null;
  }

  resize(cssW) {
    const pr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.k = (cssW * pr) / W;
    this.cv.width = Math.round(W * this.k);
    this.cv.height = Math.round(H * this.k);
    this.cv.style.width = cssW + 'px';
    this.cv.style.height = (cssW * H / W) + 'px';
    this.bg = null;
    this.buildSprites();
  }

  makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * this.k); c.height = Math.ceil(h * this.k);
    const x = c.getContext('2d');
    x.scale(this.k, this.k);
    return [c, x];
  }

  buildBackground(cave) {
    const [c, x] = this.makeCanvas(W, H);
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2a2d3a'); g.addColorStop(0.15, '#1b1713'); g.addColorStop(1, '#14100d');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    // rocks
    x.lineJoin = 'round';
    for (const p of cave.rocks) {
      x.beginPath(); x.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]);
      x.closePath();
      x.fillStyle = '#4d4338'; x.fill();
      x.lineWidth = 3; x.strokeStyle = '#6d5f4e'; x.stroke();
      x.lineWidth = 1; x.strokeStyle = 'rgba(0,0,0,0.35)'; x.stroke();
    }
    // side walls
    x.fillStyle = '#2b241d'; x.fillRect(0, 0, 3, H); x.fillRect(W - 3, 0, 3, H);
    // spawn & castle
    x.font = '16px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('⛺', 22, 14); x.fillText('⛺', W - 22, 14); x.fillText('⛺', W / 2, 14);
    x.fillStyle = '#5b5a63'; x.fillRect(0, LEAK_Y, W, H - LEAK_Y);
    x.fillStyle = '#7b7a85';
    for (let cx = 0; cx < W; cx += 24) x.fillRect(cx, LEAK_Y - 4, 14, 6);
    x.fillStyle = '#fff'; x.fillText('🏰', W / 2, LEAK_Y + 8);
    this.bg = c; this.caveRef = cave;
  }

  buildSprites() {
    this.sprites = GOBLINS.map(g => {
      const s = g.r * 2 + 4;
      const [c, x] = this.makeCanvas(s, s);
      x.translate(s / 2, s / 2);
      x.fillStyle = g.color; x.beginPath(); x.arc(0, 0, g.r, 0, 7); x.fill();
      x.lineWidth = 1.5; x.strokeStyle = 'rgba(0,0,0,0.55)'; x.stroke();
      x.fillStyle = 'rgba(255,255,255,0.35)'; x.beginPath(); x.arc(-g.r * 0.3, -g.r * 0.3, g.r * 0.35, 0, 7); x.fill();
      return { c, s };
    });
  }

  draw(game, ui) {
    const ctx = this.ctx, k = this.k;
    if (!this.bg || this.caveRef !== game.cave) this.buildBackground(game.cave);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(k, 0, 0, k, 0, 0);

    if (ui.selPoint) {
      const { x, y } = ui.selPoint;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.moveTo(x - 20, y); ctx.lineTo(x - 8, y); ctx.moveTo(x + 8, y); ctx.lineTo(x + 20, y);
      ctx.moveTo(x, y - 20); ctx.lineTo(x, y - 8); ctx.moveTo(x, y + 8); ctx.lineTo(x, y + 20); ctx.stroke();
    }
    if (ui.selTower) {
      const t = ui.selTower;
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(t.x, t.y, t.range, 0, 7); ctx.fill(); ctx.stroke();
    }

    // balls
    const { n, x, y, hp, maxhp, type, slowT } = game;
    for (let i = 0; i < n; i++) {
      const sp = this.sprites[type[i]];
      const f = hp[i] / maxhp[i];
      ctx.globalAlpha = f > 0.99 ? 1 : 0.4 + 0.6 * Math.max(0, f);   // damaged balls fade
      ctx.drawImage(sp.c, x[i] - sp.s / 2, y[i] - sp.s / 2, sp.s, sp.s);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#7fd4ff'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i < n; i++) if (slowT[i] > 0) { const r = GOBLINS[type[i]].r + 2; ctx.moveTo(x[i] + r, y[i]); ctx.arc(x[i], y[i], r, 0, 6.3); }
    ctx.stroke();
    // boss health bars
    for (let i = 0; i < n; i++) if (type[i] === 3 && hp[i] > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x[i] - 15, y[i] - 22, 30, 4);
      ctx.fillStyle = '#e74c3c'; ctx.fillRect(x[i] - 14, y[i] - 21, 28 * hp[i] / maxhp[i], 2);
    }

    for (const t of game.towers) this.drawTower(ctx, t);

    // effects
    for (const f of game.fx) {
      const a = 1 - f.age / f.life;
      ctx.globalAlpha = Math.max(0, a);
      ctx.strokeStyle = f.c;
      if (f.k === 'line') {
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(f.x1, f.y1); ctx.lineTo(f.x2, f.y2); ctx.stroke();
      } else if (f.k === 'ring') {
        const r = f.grow ? f.r * (1 - a * 0.8) : f.r * (0.4 + 0.6 * (1 - a));
        ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, 7); ctx.stroke();
        if (!f.grow) { ctx.fillStyle = f.c; ctx.globalAlpha = a * 0.25; ctx.fill(); }
      } else if (f.k === 'bolt') {
        ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(f.pts[0], f.pts[1]);
        for (let j = 2; j < f.pts.length; j += 2) {
          const mx = (f.pts[j - 2] + f.pts[j]) / 2 + (Math.random() - 0.5) * 8, my = (f.pts[j - 1] + f.pts[j + 1]) / 2 + (Math.random() - 0.5) * 8;
          ctx.lineTo(mx, my); ctx.lineTo(f.pts[j], f.pts[j + 1]);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    if (ui.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 32px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('PAUSED', W / 2, H / 2);
    }
  }

  drawTower(ctx, t) {
    const def = TOWERS[t.type];
    ctx.fillStyle = '#2c3e50'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(t.x, t.y, 13, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.color;
    ctx.beginPath(); ctx.arc(t.x, t.y, 9.5, 0, 7); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(t.ang);
    ctx.fillStyle = '#222';
    if (t.type === 'arrow') ctx.fillRect(2, -2, 15, 4);
    else if (t.type === 'cannon') ctx.fillRect(0, -4, 16, 8);
    else { ctx.fillStyle = t.type === 'tesla' ? '#fff6a0' : '#e8f8ff'; ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.fill(); }
    ctx.restore();
    ctx.fillStyle = '#ffd54f';
    for (let i = 0; i < t.lvl; i++) { ctx.beginPath(); ctx.arc(t.x - (t.lvl - 1) * 2.5 + i * 5, t.y + 17, 1.8, 0, 7); ctx.fill(); }
  }
}

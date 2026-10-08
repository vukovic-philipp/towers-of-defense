// Canvas renderer. Static map and goblin sprites are pre-rendered once per resize.
import {
  COLS, ROWS, TILE, W, H, WP_PX, PATH_CELLS, GOBLINS, TOWERS,
} from './data.js';

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.k = 1;
  }

  resize(cssW, cssH) {
    const pr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.k = (cssW * pr) / W;
    this.cv.width = Math.round(W * this.k);
    this.cv.height = Math.round(H * this.k);
    this.cv.style.width = cssW + 'px';
    this.cv.style.height = (cssW * H / W) + 'px';
    this.buildBackground();
    this.buildSprites();
  }

  makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * this.k); c.height = Math.ceil(h * this.k);
    const x = c.getContext('2d');
    x.scale(this.k, this.k);
    return [c, x];
  }

  buildBackground() {
    const [c, x] = this.makeCanvas(W, H);
    for (let r = 0; r < ROWS; r++) for (let q = 0; q < COLS; q++) {
      x.fillStyle = (r + q) & 1 ? '#3d6b3a' : '#437441';
      x.fillRect(q * TILE, r * TILE, TILE, TILE);
    }
    x.strokeStyle = 'rgba(0,0,0,0.07)'; x.lineWidth = 1;
    x.beginPath();
    for (let q = 0; q <= COLS; q++) { x.moveTo(q * TILE, 0); x.lineTo(q * TILE, H); }
    for (let r = 0; r <= ROWS; r++) { x.moveTo(0, r * TILE); x.lineTo(W, r * TILE); }
    x.stroke();
    // path
    x.lineJoin = 'round'; x.lineCap = 'butt';
    const poly = () => { x.beginPath(); WP_PX.forEach(([px, py], i) => i ? x.lineTo(px, py) : x.moveTo(px, py)); x.stroke(); };
    x.strokeStyle = '#6e5230'; x.lineWidth = TILE; poly();
    x.strokeStyle = '#b8935c'; x.lineWidth = TILE - 6; poly();
    x.strokeStyle = 'rgba(255,255,255,0.08)'; x.lineWidth = 2; x.setLineDash([6, 10]); poly(); x.setLineDash([]);
    // markers
    x.font = '16px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('⛺', TILE * 0.5, TILE * 1.5 - 1);
    x.fillText('🏰', TILE * 1.5, H - TILE * 0.5 - 2);
    this.bg = c;
  }

  buildSprites() {
    this.sprites = GOBLINS.map((g, idx) => {
      const s = g.r * 2 + 8;
      const [c, x] = this.makeCanvas(s, s);
      x.translate(s / 2, s / 2);
      const r = g.r;
      x.fillStyle = 'rgba(0,0,0,0.25)'; x.beginPath(); x.ellipse(0, r * 0.7, r * 0.9, r * 0.4, 0, 0, 7); x.fill();
      // ears
      x.fillStyle = g.color; x.strokeStyle = 'rgba(0,0,0,0.55)'; x.lineWidth = 1.2;
      for (const sx of [-1, 1]) {
        x.beginPath(); x.moveTo(sx * r * 0.7, -r * 0.2); x.lineTo(sx * (r + 4), -r * 0.9); x.lineTo(sx * r * 0.9, r * 0.35); x.closePath(); x.fill(); x.stroke();
      }
      x.beginPath(); x.arc(0, 0, r, 0, 7); x.fill(); x.stroke();
      // eyes
      x.fillStyle = '#ffeb3b';
      x.beginPath(); x.arc(-r * 0.38, -r * 0.15, r * 0.24, 0, 7); x.arc(r * 0.38, -r * 0.15, r * 0.24, 0, 7); x.fill();
      x.fillStyle = '#111';
      x.beginPath(); x.arc(-r * 0.38, -r * 0.1, r * 0.1, 0, 7); x.arc(r * 0.38, -r * 0.1, r * 0.1, 0, 7); x.fill();
      x.strokeStyle = '#111'; x.lineWidth = 1.2; x.beginPath(); x.moveTo(-r * 0.35, r * 0.42); x.lineTo(r * 0.35, r * 0.42); x.stroke();
      if (idx === 2) { x.fillStyle = '#8d6e63'; x.fillRect(-r * 0.8, -r - 1, r * 1.6, r * 0.45); } // helmet
      if (idx === 3) { // crown
        x.fillStyle = '#f1c40f'; x.beginPath();
        x.moveTo(-r * 0.7, -r * 0.8); x.lineTo(-r * 0.7, -r * 1.35); x.lineTo(-r * 0.3, -r * 1.0); x.lineTo(0, -r * 1.5);
        x.lineTo(r * 0.3, -r * 1.0); x.lineTo(r * 0.7, -r * 1.35); x.lineTo(r * 0.7, -r * 0.8); x.closePath(); x.fill();
      }
      return { c, s };
    });
  }

  draw(game, ui) {
    const ctx = this.ctx, k = this.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(k, 0, 0, k, 0, 0);

    // selection / ranges
    if (ui.selTile) {
      const { c, r } = ui.selTile;
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(c * TILE + 1, r * TILE + 1, TILE - 2, TILE - 2);
    }
    if (ui.selTower) {
      const t = ui.selTower;
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(t.x, t.y, t.range, 0, 7); ctx.fill(); ctx.stroke();
    }

    for (const t of game.towers) this.drawTower(ctx, t);

    // goblins
    const { n, x, y, hp, maxhp, type, slowT } = game;
    for (let i = 0; i < n; i++) {
      const sp = this.sprites[type[i]];
      ctx.drawImage(sp.c, x[i] - sp.s / 2, y[i] - sp.s / 2, sp.s, sp.s);
    }
    // slow rings + hp bars (batched)
    ctx.strokeStyle = '#7fd4ff'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i < n; i++) if (slowT[i] > 0) { const r = GOBLINS[type[i]].r + 2; ctx.moveTo(x[i] + r, y[i]); ctx.arc(x[i], y[i], r, 0, 6.3); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.beginPath();
    for (let i = 0; i < n; i++) if (hp[i] < maxhp[i]) { const w = GOBLINS[type[i]].r * 2; ctx.rect(x[i] - w / 2 - 0.5, y[i] - GOBLINS[type[i]].r - 7, w + 1, 4); }
    ctx.fill();
    ctx.fillStyle = '#e74c3c'; ctx.beginPath();
    for (let i = 0; i < n; i++) if (hp[i] < maxhp[i]) { const w = GOBLINS[type[i]].r * 2; ctx.rect(x[i] - w / 2, y[i] - GOBLINS[type[i]].r - 6, w * Math.max(0, hp[i]) / maxhp[i], 2); }
    ctx.fill();

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
    ctx.fillStyle = '#2c3e50'; ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(t.x - 16, t.y - 16, 32, 32, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.color;
    ctx.beginPath(); ctx.arc(t.x, t.y, 11, 0, 7); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(t.ang);
    ctx.fillStyle = '#222';
    if (t.type === 'arrow') ctx.fillRect(2, -2, 16, 4);
    else if (t.type === 'cannon') ctx.fillRect(0, -4, 17, 8);
    else if (t.type === 'tesla') { ctx.fillStyle = '#fff6a0'; ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.fill(); }
    else { ctx.fillStyle = '#e8f8ff'; ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.fill(); }
    ctx.restore();
    ctx.fillStyle = '#ffd54f';
    for (let i = 0; i < t.lvl; i++) { ctx.beginPath(); ctx.arc(t.x - (t.lvl - 1) * 3 + i * 6, t.y + 13, 2, 0, 7); ctx.fill(); }
  }
}

// Turret workshop overlay: pick a behaviour, spread stat points, add perks, save the design.
import { TOWERS, statLine } from './data.js';
import {
  SLIDERS, PERKS, perksFor, defaultPts, maxPoints, usedPoints, sanitize, designBase, designCost, discount, MAX_PTS,
} from './design.js';
import { saveMeta } from './meta.js';

const COLORS = ['#5eead4', '#60a5fa', '#ff7a45', '#fbbf24', '#f472b6', '#a78bfa', '#4ade80', '#e6edf3'];
const DOT = ['', 'dia', '', 'sq'];

export function initWorkshop({ root, body, slotsEl, close, meta, getFx, onChange }) {
  let cur;
  const fresh = (kind = 0) => ({ id: null, name: `Custom ${TOWERS[kind].name}`, color: COLORS[kind], kind, pts: defaultPts(kind), perks: [] });
  cur = fresh();
  const $ = (sel) => body.querySelector(sel);

  const valueText = (kind, key, b) => {
    if (key === 'dmg') return kind === 1 || kind === 2 ? `${Math.round(b.dmg)} dps` : `${Math.round(b.dmg)} dmg`;
    if (key === 'rate') return `${b.rate.toFixed(2)}/s`;
    if (key === 'range') return `${Math.round(b.range)} px`;
    if (key === 'ignite') return `${Math.round(b.ignite)}/s`;
    if (key === 'radius') {
      if (kind === 1) return `${(b.radius * 2).toFixed(0)} px wide`;
      if (kind === 2) return `${Math.round((Math.acos(b.radius) * 360) / Math.PI)} deg`;
      return `r ${Math.round(b.radius)}`;
    }
    return '';
  };
  const price = () => discount(designCost(cur.kind, cur.pts, cur.perks), getFx().towerDisc);

  function renderSliders() {
    const fx = getFx(), box = $('#wsSliders'), b = designBase(cur.kind, cur.pts, cur.perks);
    box.innerHTML = '';
    for (const [key, label] of Object.entries(SLIDERS[cur.kind])) {
      const row = document.createElement('label'); row.className = 'slrow';
      row.innerHTML = `<span>${label}</span><input type="range" min="0" max="${MAX_PTS}" step="1" value="${cur.pts[key]}"><output>${valueText(cur.kind, key, b)}</output>`;
      const input = row.querySelector('input'), out = row.querySelector('output');
      input.addEventListener('input', () => {
        const others = usedPoints(cur.pts) - cur.pts[key];
        const v = Math.min(+input.value, maxPoints(cur.kind, fx.budget) - others);
        input.value = v; cur.pts[key] = v;
        updateReadouts();
      });
      row._out = out; row._key = key; box.appendChild(row);
    }
  }
  function renderPerks() {
    const fx = getFx(), box = $('#wsPerks');
    box.innerHTML = '';
    for (const id of perksFor(cur.kind)) {
      const p = PERKS[id], open = fx.perks.has(id), on = cur.perks.includes(id);
      const chip = document.createElement('button');
      chip.className = 'chip' + (on ? ' on' : '') + (open ? '' : ' lock');
      chip.innerHTML = `<b>${p.name}</b><small>${open ? p.desc : 'Locked: research it'}</small>`;
      chip.disabled = !open;
      chip.addEventListener('click', () => {
        if (on) cur.perks = cur.perks.filter((x) => x !== id);
        else if (cur.perks.length < fx.perkSlots) cur.perks.push(id);
        else return;
        renderPerks(); updateReadouts();
      });
      box.appendChild(chip);
    }
  }
  function updateReadouts() {
    const fx = getFx(), b = designBase(cur.kind, cur.pts, cur.perks);
    for (const row of body.querySelectorAll('.slrow')) row._out.textContent = valueText(cur.kind, row._key, b);
    const used = usedPoints(cur.pts), cap = maxPoints(cur.kind, fx.budget);
    $('#wsPts').innerHTML = `Points <b>${used}</b> of ${cap} &nbsp; Perks <b>${cur.perks.length}</b> of ${fx.perkSlots}`;
    $('#wsPrev').innerHTML = `<div class="hd"><span class="dot ${DOT[cur.kind]}" style="border-color:${cur.color}"></span>${escapeHtml(cur.name || 'Unnamed')}</div>
      <dl><dt>Behaviour</dt><dd>${TOWERS[cur.kind].name}: ${TOWERS[cur.kind].blurb}</dd>
      <dt>Stats</dt><dd>${statLine(cur.kind, b)}</dd><dt>Range</dt><dd>${Math.round(b.range)} px</dd>
      <dt>Perks</dt><dd>${cur.perks.length ? cur.perks.map((p) => PERKS[p].name).join(', ') : 'none'}</dd>
      <dt>Price</dt><dd class="price">${price()} gold</dd></dl>`;
    const editing = cur.id && meta.designs.some((d) => d.id === cur.id);
    const full = !editing && meta.designs.length >= fx.slots;
    const save = $('#wsSave');
    save.disabled = full || !cur.name.trim();
    save.textContent = editing ? 'Update design' : full ? 'No free slots' : 'Save design';
    slotsEl.textContent = `${meta.designs.length}/${fx.slots}`;
  }
  function renderSaved() {
    const box = $('#wsSaved'), fx = getFx();
    box.innerHTML = meta.designs.length ? '' : '<p class="muted">No saved designs yet. Saved designs show up as build options next to the standard towers.</p>';
    for (const raw of meta.designs) {
      const d = sanitize(raw), item = document.createElement('div'); item.className = 'item';
      item.innerHTML = `<span class="dot ${DOT[d.kind]}" style="width:16px;height:16px;border:3px solid ${d.color};border-radius:${d.kind === 3 ? 4 : 99}px;flex:none"></span>
        <div class="nm"><b>${escapeHtml(d.name)}</b><span>${TOWERS[d.kind].name}, ${discount(designCost(d.kind, d.pts, d.perks), fx.towerDisc)} gold</span></div>
        <button data-a="edit">Edit</button><button data-a="del">Delete</button>`;
      item.querySelector('[data-a=edit]').addEventListener('click', () => { cur = JSON.parse(JSON.stringify(d)); build(); });
      item.querySelector('[data-a=del]').addEventListener('click', () => {
        meta.designs = meta.designs.filter((x) => x.id !== d.id);
        if (cur.id === d.id) cur = fresh(cur.kind);
        saveMeta(meta); onChange(); build();
      });
      box.appendChild(item);
    }
  }
  function build() {
    body.innerHTML = `<div class="wsgrid">
      <div class="wsform">
        <h4>Name</h4><input type="text" id="wsName" maxlength="14" autocomplete="off" spellcheck="false">
        <h4>Colour</h4><div class="swatches" id="wsColors"></div>
        <h4>Behaviour</h4><div class="seg" id="wsKinds"></div>
        <h4>Stat points</h4><div id="wsSliders" class="wsform"></div><div class="pts" id="wsPts"></div>
        <h4>Perks</h4><div class="chips" id="wsPerks"></div>
      </div>
      <div class="wspane">
        <h4>Preview</h4><div class="preview" id="wsPrev"></div>
        <div class="split"><button id="wsSave" class="primary big">Save design</button><button id="wsNew" class="big">New design</button></div>
        <h4>Saved designs</h4><div class="saved" id="wsSaved"></div>
      </div></div>`;
    const name = $('#wsName'); name.value = cur.name;
    name.addEventListener('input', () => { cur.name = name.value; updateReadouts(); });
    const colors = $('#wsColors');
    for (const c of COLORS) {
      const b = document.createElement('button'); b.className = 'sw' + (c === cur.color ? ' on' : ''); b.style.background = c; b.setAttribute('aria-label', `Colour ${c}`);
      b.addEventListener('click', () => { cur.color = c; for (const x of colors.children) x.classList.toggle('on', x === b); updateReadouts(); });
      colors.appendChild(b);
    }
    const kinds = $('#wsKinds');
    TOWERS.forEach((t, k) => {
      const b = document.createElement('button'); b.textContent = t.name; if (k === cur.kind) b.className = 'on';
      b.addEventListener('click', () => {
        if (k === cur.kind) return;
        const keepName = cur.name === `Custom ${TOWERS[cur.kind].name}`;
        const keepColor = cur.color === COLORS[cur.kind];
        cur = { ...cur, kind: k, pts: defaultPts(k), perks: cur.perks.filter((p) => perksFor(k).includes(p)) };
        if (keepName) cur.name = `Custom ${t.name}`;
        if (keepColor) cur.color = COLORS[k];
        build();
      });
      kinds.appendChild(b);
    });
    $('#wsSave').addEventListener('click', () => {
      const d = sanitize({ ...cur, name: cur.name.trim().slice(0, 14) });
      if (d.id && meta.designs.some((x) => x.id === d.id)) meta.designs = meta.designs.map((x) => (x.id === d.id ? d : x));
      else { d.id = 'd' + Date.now().toString(36); meta.designs.push(d); }
      cur = JSON.parse(JSON.stringify(d));
      saveMeta(meta); onChange(); build();
    });
    $('#wsNew').addEventListener('click', () => { cur = fresh(cur.kind); build(); });
    renderSliders(); renderPerks(); renderSaved(); updateReadouts();
  }
  close.addEventListener('click', () => { root.classList.add('hidden'); if (api.onClose) api.onClose(); });
  const api = {
    onClose: null,
    open() { root.classList.remove('hidden'); build(); },
  };
  return api;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

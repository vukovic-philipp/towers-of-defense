// Research tree overlay: permanent upgrades bought with the points earned when a run ends.
import { RESEARCH, BRANCHES, level, status, buyResearch, saveMeta, researchNode } from './meta.js';

export function initResearch({ root, body, points, close, meta, onChange }) {
  function render() {
    points.textContent = meta.shards;
    let html = '<div class="rgrid">';
    BRANCHES.forEach((name, b) => {
      html += `<div class="rcol"><h4>${name}</h4>`;
      for (const n of RESEARCH.filter((x) => x.branch === b)) {
        const st = status(meta, n.id), l = level(meta, n.id);
        let tag = st === 'maxed' ? 'Maxed' : st === 'locked' ? `Requires ${researchNode(n.req[0]).name}${researchNode(n.req[0]).max > 1 ? ' ' + n.req[1] : ''}` : `${n.cost[l]} points`;
        html += `<button class="rnode ${st}" data-id="${n.id}" ${st === 'ok' ? '' : 'disabled'}><b>${n.name}<i>${l}/${n.max}</i></b><small>${n.desc}</small><span class="cs">${tag}</span></button>`;
      }
      html += '</div>';
    });
    body.innerHTML = html + '</div>';
    for (const btn of body.querySelectorAll('.rnode.ok')) {
      btn.addEventListener('click', () => {
        if (buyResearch(meta, btn.dataset.id)) { saveMeta(meta); onChange(); render(); }
      });
    }
  }
  close.addEventListener('click', () => root.classList.add('hidden'));
  return { open() { root.classList.remove('hidden'); render(); }, render };
}

// Field Guide: searchable cheat sheet, debug map and glossary.

import { h, clear } from '../ui/dom.js';
import { renderInline } from '../ui/markdown.js';

import { SHEET, DEBUG, GLOSSARY } from '../content/guide-data.js';

export function renderGuide(section) {
  const page = h('div', { class: 'page' });
  page.append(h('p', { class: 'eyebrow' }, 'Field Guide'), h('h1', { style: { fontSize: 'var(--step-4)', fontWeight: 800, letterSpacing: '-.025em' } }, 'Every command, in one place'),
    h('p', { class: 'lede' }, 'A searchable reference to keep open while you work. Every command here also runs in the Sandbox.'));
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search commands and terms, e.g. "port", "permission", "502", "rollback"', 'aria-label': 'Search the field guide', id: 'guide-search' });
  const nav = h('nav', { class: 'guide-nav', 'aria-label': 'Guide sections' });
  const body = h('div');
  page.append(h('div', { style: { margin: '20px 0' } }, search), h('div', { class: 'guide-grid' }, nav, body));
  for (const [title] of SHEET) nav.append(h('a', { href: `#/guide/${slug(title)}` }, title));
  nav.append(h('a', { href: '#/guide/debug-map' }, 'Debug map'), h('a', { href: '#/guide/glossary' }, 'Glossary'));

  const draw = (q = '') => {
    clear(body);
    const ql = q.toLowerCase();
    for (const [title, rows] of SHEET) {
      const hits = rows.filter(([c, d]) => !ql || c.toLowerCase().includes(ql) || d.toLowerCase().includes(ql) || title.toLowerCase().includes(ql));
      if (!hits.length) continue;
      const table = h('table', { class: 'cheat' }, h('tbody', {}, hits.map(([c, d]) => { const td = h('td'); td.innerHTML = renderInline(d); return h('tr', {}, h('td', {}, c), td); })));
      body.append(h('section', { id: `g-${slug(title)}`, style: { marginBottom: '32px' } }, h('h2', { style: { fontSize: 'var(--step-2)', marginBottom: '8px' } }, title), h('div', { style: { overflowX: 'auto' } }, table)));
    }
    const dbg = DEBUG.filter(([sym, why, cmds]) => !ql || [sym, why, cmds].join(' ').toLowerCase().includes(ql) || 'debug troubleshoot broken'.includes(ql));
    if (dbg.length) {
      const table = h('table', { class: 'cheat debug' }, h('thead', {}, h('tr', {}, h('th', {}, 'Symptom'), h('th', {}, 'Usual causes'), h('th', {}, 'Check first'))),
        h('tbody', {}, dbg.map(([sym, why, cmds]) => { const a = h('td'); a.innerHTML = renderInline(why); const b = h('td'); b.innerHTML = renderInline(cmds); return h('tr', {}, h('td', {}, h('strong', {}, sym)), a, b); })));
      body.append(h('section', { id: 'g-debug-map', style: { marginBottom: '32px' } }, h('h2', { style: { fontSize: 'var(--step-2)', marginBottom: '8px' } }, 'Debug map'), h('p', { style: { color: 'var(--muted)', margin: '0 0 10px' } }, 'Read the error first. Then work from the outside in: name → network → port → process → logs → config.'), h('div', { style: { overflowX: 'auto' } }, table)));
    }
    const gl = GLOSSARY.filter(([t, d]) => !ql || t.toLowerCase().includes(ql) || d.toLowerCase().includes(ql));
    if (gl.length) {
      const dl = h('dl', { style: { display: 'grid', gap: '10px', margin: 0 } });
      for (const [t, d] of gl) { const dd = h('dd', { style: { margin: 0, color: 'var(--text-2)' } }); dd.innerHTML = renderInline(d); dl.append(h('div', {}, h('dt', { style: { fontWeight: 700 } }, t), dd)); }
      body.append(h('section', { id: 'g-glossary' }, h('h2', { style: { fontSize: 'var(--step-2)', marginBottom: '8px' } }, 'Glossary'), dl));
    }
    if (!body.children.length) body.append(h('p', { style: { color: 'var(--muted)' } }, `Nothing matches "${q}".`));
  };
  search.addEventListener('input', () => draw(search.value.trim()));
  draw();
  if (section) setTimeout(() => document.getElementById(`g-${section}`)?.scrollIntoView({ block: 'start' }), 30);
  return page;
}

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

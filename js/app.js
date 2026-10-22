// Boot + hash router.

import { h, clear } from './ui/dom.js';
import { renderHub } from './views/hub.js';
import { renderLesson } from './views/lesson.js';
import { renderPath, renderRealm, renderSandbox, renderProfile } from './views/pages.js';
import { renderGuide } from './views/guide.js';
import { subscribe, getState, rankFor, nextRank, checkStreak } from './store.js';

const view = document.getElementById('view');
let current = null;

function renderRank() {
  const box = document.getElementById('rankbox');
  if (!box) return;
  const st = getState();
  const r = rankFor(st.xp);
  const n = nextRank(st.xp);
  const frac = n ? (st.xp - r.xp) / (n.xp - r.xp) : 1;
  clear(box);
  box.append(h('a', { class: 'rank-pill', href: '#/profile', title: n ? `${n.xp - st.xp} XP to ${n.name}` : 'Top rank reached' },
    h('span', { class: 'rank-name' }, r.name),
    h('span', { class: 'xpbar', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.round(frac * 100)}%` } })),
    h('span', { class: 'xp-num' }, `${st.xp} XP`)));
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean).map(decodeURIComponent);
  current?.destroy?.();
  current = null;
  clear(view);
  let navKey = 'world';
  let el;
  try {
    if (!parts.length) { const hub = renderHub(); current = hub; el = hub.el; }
    else if (parts[0] === 'path') { el = renderPath(); navKey = 'path'; }
    else if (parts[0] === 'realm') { el = renderRealm(parts[1]); navKey = 'path'; }
    else if (parts[0] === 'lesson') { el = renderLesson(`${parts[1]}/${parts[2]}`, parts[3] || null, Number(parts[4] || 0)); navKey = 'path'; }
    else if (parts[0] === 'sandbox') { el = renderSandbox(); navKey = 'sandbox'; }
    else if (parts[0] === 'guide') { el = renderGuide(parts[1]); navKey = 'guide'; }
    else if (parts[0] === 'profile') { el = renderProfile(); navKey = 'profile'; }
    else el = h('div', { class: 'page' }, h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: '#/' }, 'Back to the world map')));
  } catch (e) {
    console.error(e);
    el = h('div', { class: 'page' }, h('h1', {}, 'Something broke on this page'), h('pre', {}, String(e.stack || e)), h('p', {}, h('a', { href: '#/' }, 'Back to the world map')));
  }
  view.append(el);
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === navKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (!parts.length || parts[0] !== 'lesson' || !parts[3]) window.scrollTo(0, 0);
  else view.scrollIntoView({ block: 'start' });
  const titleBits = { path: 'Path', realm: 'Realm', lesson: 'Lesson', sandbox: 'Sandbox', guide: 'Field Guide', profile: 'Profile' };
  document.title = parts.length ? `${titleBits[parts[0]] || 'Git Conquest'} · Git Conquest` : 'Git Conquest';
}

function initTheme() {
  const btn = document.getElementById('themeToggle');
  let saved = null;
  try { saved = localStorage.getItem('git-conquest:theme'); } catch { /* ignore */ }
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  btn?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('git-conquest:theme', next); } catch { /* ignore */ }
  });
}

initTheme();
renderRank();
subscribe(renderRank);
checkStreak();
window.addEventListener('hashchange', route);
route();

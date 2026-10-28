// Path, realm, sandbox, profile pages.

import { h, clear, ring, toast } from '../ui/dom.js';
import { renderMarkdown } from '../ui/markdown.js';
import { curriculum } from '../curriculum.js';
import { Quiz } from '../ui/quiz.js';
import { Terminal } from '../ui/terminal.js';
import { GitHubView } from '../ui/panels.js';
import { SystemView, FileTreeView, NetworkView } from '../ui/devpanels.js';
import { extraPanels } from '../ui/panelRegistry.js';
import { buildLabWorld } from '../lab.js';
import { SCENARIOS } from '../content/sandbox.js';
import {
  isMastered, isUnlocked, realmProgress, realmUnlocked, lessonState, currentLessonId, getState, RANKS, rankFor, nextRank,
  BADGES, testOutRealm, resetAll, exportProgress, parseProgress, importProgress, clearMissed, bumpSandbox, grant, PASS_MARK,
} from '../store.js';

function lessonRow(l) {
  const ls = lessonState(l.id);
  const open = isUnlocked(l.id);
  const cur = currentLessonId() === l.id;
  const status = ls.mastered ? (ls.testedOut ? 'tested out' : 'mastered') : !open ? 'locked' : cur ? 'current' : 'open';
  const inner = [
    h('span', { class: 'node-dot' + (ls.mastered ? ' is-done' : open ? ' is-open' : '') + (l.boss ? ' is-boss' : ''), 'aria-hidden': 'true' }),
    h('span', {}, h('span', { class: 'ln-t' }, l.title), h('br'), h('span', { class: 'ln-s' }, l.summary)),
    h('span', { class: 'pill ' + (ls.mastered ? 'pill-ok' : cur ? 'pill-accent' : !open ? 'pill-lock' : '') }, status),
  ];
  return open ? h('a', { class: 'lesson-row', href: `#/lesson/${l.id}` }, inner) : h('div', { class: 'lesson-row is-locked', 'aria-disabled': 'true' }, inner);
}

export function renderPath() {
  const page = h('div', { class: 'page' });
  const total = curriculum.order.length;
  const done = curriculum.order.filter(isMastered).length;
  page.append(
    h('p', { class: 'eyebrow' }, 'The path'),
    h('h1', { style: { fontSize: 'var(--step-4)', fontWeight: 800, letterSpacing: '-.025em' } }, 'From first command to DevOps Hero'),
    h('p', { class: 'lede' }, `${curriculum.realms.length} realms, ${total} lessons. Each lesson: learn it from several angles, practise it in the simulator, prove it in a quiz. ${done ? `You have mastered ${done} of ${total}.` : 'Start at the top. Already experienced? Each realm has a test-out exam.'}`));
  const grid = h('div', { class: 'path-grid' });
  for (const r of curriculum.realms) {
    const p = realmProgress(r);
    grid.append(h('section', { class: 'realm-block', id: `realm-${r.id}` },
      h('div', { class: 'realm-meta' },
        h('span', { class: 'eyebrow' }, `Realm ${r.n}`),
        h('h2', {}, h('a', { href: `#/realm/${r.id}`, style: { color: 'inherit', textDecoration: 'none' } }, r.title)),
        h('p', {}, r.tagline),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, ring(p.fraction), h('span', { style: { color: 'var(--muted)', fontSize: '.9rem' } }, `${p.done} of ${p.total} mastered`))),
      h('ol', { class: 'lesson-list' }, r.lessons.map(l => h('li', {}, lessonRow(l))))));
  }
  page.append(grid);
  return page;
}

export function renderRealm(id) {
  const r = curriculum.realmById[id];
  const page = h('div', { class: 'page page-narrow' });
  if (!r) { page.append(h('h1', {}, 'Realm not found')); return page; }
  const p = realmProgress(r);
  const unlocked = realmUnlocked(r);
  page.append(
    h('nav', { class: 'crumbs' }, h('a', { href: '#/path' }, 'Path'), '/', h('span', {}, `Realm ${r.n}`)),
    h('h1', { style: { fontSize: 'var(--step-4)', fontWeight: 800, letterSpacing: '-.025em', margin: '8px 0' } }, r.title),
    h('p', { class: 'lede' }, r.tagline));
  if (r.intro) { const d = h('div', { class: 'prose', style: { margin: '18px 0' } }); d.innerHTML = renderMarkdown(r.intro); page.append(d); }
  page.append(h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', margin: '18px 0' } }, ring(p.fraction), h('span', {}, `${p.done} of ${p.total} lessons mastered`), r.badge ? h('span', { class: 'pill' + (p.done === p.total ? ' pill-accent' : '') }, `Badge: ${r.badge}`) : null));
  page.append(h('ol', { class: 'lesson-list' }, r.lessons.map(l => h('li', {}, lessonRow(l)))));

  // test-out
  const box = h('section', { style: { marginTop: '36px', paddingTop: '24px', borderTop: '1px solid var(--line)' } });
  page.append(box);
  const pool = r.lessons.flatMap(l => (l.quiz || []).map((q, i) => ({ ...q, id: `${l.id}#${i}` })));
  if (p.done === p.total) {
    box.append(h('h2', { style: { fontSize: 'var(--step-2)' } }, 'Realm conquered'), h('p', { style: { color: 'var(--text-2)' } }, 'Every lesson here is mastered. Revisit any of them for practice; your progress is kept.'));
  } else if (!unlocked) {
    box.append(h('h2', { style: { fontSize: 'var(--step-2)' } }, 'Test out of this realm'), h('p', { style: { color: 'var(--text-2)' } }, 'Finish the realm before this one to unlock its test-out exam.'));
  } else if (pool.length) {
    box.append(h('h2', { style: { fontSize: 'var(--step-2)' } }, 'Already know this? Test out.'),
      h('p', { style: { color: 'var(--text-2)', maxWidth: '62ch' } }, `A ${Math.min(12, pool.length)}-question exam drawn from every lesson in this realm. Score ${Math.round(0.9 * 100)}% or more and the whole realm counts as mastered. Miss it and nothing is lost: work through the lessons as normal.`));
    const start = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
      clear(box);
      const quiz = new Quiz(pool, {
        count: 12, passMark: 0.9, title: `Test-out exam · ${r.title}`,
        onFinish: ({ pass, actions, retry }) => {
          if (pass) { testOutRealm(r); actions.append(h('a', { class: 'btn btn-primary', href: '#/path' }, 'Back to the path')); }
          else { actions.append(h('button', { class: 'btn', type: 'button', onclick: retry }, 'Try another exam'), h('a', { class: 'btn btn-primary', href: `#/lesson/${r.lessons.find(l => !isMastered(l.id)).id}` }, 'Learn it lesson by lesson')); }
        },
      });
      box.append(quiz.el);
    } }, 'Start the test-out exam');
    box.append(start);
  }
  return page;
}

export function renderSandbox() {
  const page = h('div', { class: 'page', style: { maxWidth: '1400px' } });
  page.append(h('p', { class: 'eyebrow' }, 'Sandbox'), h('h1', { style: { fontSize: 'var(--step-3)', fontWeight: 800 } }, 'Break things. Nothing here is real.'),
    h('p', { class: 'lede', style: { marginBottom: '14px' } }, 'Simulated machines, networks and pipelines. Pick a starting point, then experiment freely: every command updates the panels on the right.'));
  const row = h('div', { class: 'scenario-row', style: { marginBottom: '14px' } });
  const noteEl = h('p', { style: { color: 'var(--muted)', margin: '0 0 12px' } });
  const grid = h('div', { class: 'sandbox-grid' });
  page.append(row, noteEl, grid);
  let active = Object.keys(SCENARIOS)[1] || Object.keys(SCENARIOS)[0];
  const load = (key) => {
    active = key;
    for (const b of row.querySelectorAll('button')) b.classList.toggle('btn-primary', b.dataset.k === key);
    clear(grid);
    const sc = SCENARIOS[key];
    noteEl.textContent = sc.note;
    const { uni, sh } = buildLabWorld(sc);
    const tabs = h('div', { class: 'panel-tabs', role: 'tablist' });
    const body = h('div', { class: 'panel-body' });
    const onAction = (m, err) => { term.print(`\x1b[${err ? 31 : 35}m[GitHub] ${m}\x1b[0m`); refresh(); };
    const views = { system: ['System', new SystemView()], files: ['Files', new FileTreeView()], network: ['Network', new NetworkView()], github: ['GitHub', new GitHubView({ onAction })] };
    for (const [k, make] of Object.entries(extraPanels)) views[k] = [make.label, make.create({ onAction, lab: null })];
    const names = (sc.panels || ['system', 'files', 'network']).filter(n => views[n]);
    let tab = names[0];
    const refresh = () => { const v = views[tab][1]; try { if (v instanceof GitHubView) v.render(sh.repo, sh); else v.render(sh, uni); } catch (e) { console.error(e); } };
    const setTab = (k) => { tab = k; for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.p === k)); clear(body); body.append(views[k][1].el); refresh(); };
    for (const k of names) tabs.append(h('button', { type: 'button', role: 'tab', dataset: { p: k }, onclick: () => setTab(k) }, views[k][0]));
    const term = new Terminal(sh, {
      title: 'sandbox — bash',
      welcome: [sc.note, 'Type `help` for the commands the simulator knows.'],
      onCommand: () => { refresh(); bumpSandbox(); },
      onReset: () => load(key),
    });
    grid.append(term.el, h('div', { class: 'panel' }, tabs, body));
    setTab(tab);
    setTimeout(() => term.focus(), 30);
  };
  for (const [k, sc] of Object.entries(SCENARIOS)) row.append(h('button', { class: 'btn btn-sm', type: 'button', dataset: { k }, onclick: () => load(k) }, sc.title));
  load(active);
  return page;
}

export function renderProfile() {
  const st = getState();
  const page = h('div', { class: 'page page-narrow' });
  const rank = rankFor(st.xp);
  const next = nextRank(st.xp);
  const mastered = curriculum.order.filter(isMastered).length;
  page.append(h('p', { class: 'eyebrow' }, 'Profile'), h('h1', { style: { fontSize: 'var(--step-4)', fontWeight: 800, letterSpacing: '-.025em' } }, rank.name), h('p', { class: 'lede' }, rank.blurb + (next ? ` ${next.xp - st.xp} XP to ${next.name}.` : ' You reached the top rank.')));
  page.append(h('div', { class: 'stat-row', style: { margin: '24px 0' } },
    h('div', { class: 'stat' }, h('div', { class: 'v' }, String(st.xp)), h('div', { class: 'k' }, 'XP')),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, `${mastered}/${curriculum.order.length}`), h('div', { class: 'k' }, 'lessons mastered')),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, String(curriculum.realms.filter(r => r.lessons.every(l => isMastered(l.id))).length)), h('div', { class: 'k' }, 'realms conquered')),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, String(st.days.length)), h('div', { class: 'k' }, 'days practised'))));

  // rank ladder
  const ladder = h('ol', { class: 'lesson-list' });
  for (const r of RANKS) {
    const reached = st.xp >= r.xp;
    ladder.append(h('li', {}, h('div', { class: 'lesson-row' + (reached ? '' : ' is-locked') },
      h('span', { class: 'node-dot' + (reached ? ' is-done' : ''), 'aria-hidden': 'true' }),
      h('span', {}, h('span', { class: 'ln-t' }, r.name), h('br'), h('span', { class: 'ln-s' }, r.blurb)),
      h('span', { class: 'pill' + (r.name === rank.name ? ' pill-accent' : '') }, `${r.xp} XP`))));
  }

  // review deck
  const missedIds = Object.keys(st.missed).filter(id => isMastered(id.split('#')[0]) || true);
  const reviewBox = h('section', { style: { margin: '32px 0' } }, h('h2', { style: { fontSize: 'var(--step-2)', marginBottom: '8px' } }, 'Review deck'));
  const questions = missedIds.map(id => {
    const [lid, idx] = id.split('#');
    const q = curriculum.byId[lid]?.quiz?.[Number(idx)];
    return q ? { ...q, id } : null;
  }).filter(Boolean);
  if (!questions.length) reviewBox.append(h('p', { style: { color: 'var(--text-2)' } }, 'Questions you get wrong in quizzes collect here, so you can revisit them later. Spacing out practice like this is what makes knowledge stick. Your deck is empty right now.'));
  else {
    reviewBox.append(h('p', { style: { color: 'var(--text-2)' } }, `${questions.length} question${questions.length === 1 ? '' : 's'} you missed before. Answer one correctly and it leaves the deck.`));
    reviewBox.append(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
      clear(reviewBox);
      const quiz = new Quiz(questions, { count: Math.min(8, questions.length), title: 'Review deck', passMark: 0, onFinish: () => {} });
      const origFinish = quiz.finish.bind(quiz);
      quiz.finish = () => {
        const right = quiz.questions.filter((_, i) => quiz.results[i]).map(q => q._id);
        clearMissed(right);
        const s = getState(); s.reviewed = (s.reviewed || 0) + right.length; if (s.reviewed >= 5) grant('reviewer');
        origFinish();
      };
      reviewBox.append(quiz.el);
    } }, 'Start a review session'));
  }
  page.append(reviewBox);

  const badges = h('div', { class: 'badges' });
  const allBadges = [...BADGES, ...curriculum.realms.map(r => ({ id: 'realm-' + r.id, title: r.badge, desc: `Conquer ${r.title}` }))];
  for (const b of allBadges) badges.append(h('div', { class: 'badge' + (st.badges.includes(b.id) ? '' : ' is-off') }, h('span', { class: 'bt' }, b.title), h('span', { class: 'bd' }, b.desc)));
  page.append(h('h2', { style: { fontSize: 'var(--step-2)', margin: '32px 0 12px' } }, 'Badges'), badges);
  page.append(h('h2', { style: { fontSize: 'var(--step-2)', margin: '32px 0 12px' } }, 'Ranks'), ladder);

  // move progress between browsers (or between the Artifact and the public site): a code, not a file,
  // because sandboxed viewers block downloads
  const move = h('section', { class: 'move-progress' },
    h('h2', { style: { fontSize: 'var(--step-1)', marginBottom: '8px' } }, 'Move your progress'),
    h('p', { style: { color: 'var(--text-2)' } }, 'Progress lives in this browser only. Copy your progress code here and load it in another browser or on another copy of the course.'));
  const codeBox = h('textarea', { class: 'progress-code', rows: '3', spellcheck: 'false', 'aria-label': 'Progress code', placeholder: 'Paste a progress code here to load it' });
  const moveMsg = h('div', { class: 'move-msg', 'aria-live': 'polite' });
  const copyBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    codeBox.value = exportProgress();
    codeBox.select();
    clear(moveMsg);
    try { await navigator.clipboard.writeText(codeBox.value); toast('Progress code copied'); }
    catch { moveMsg.append(h('span', {}, 'The code is selected above: copy it with Ctrl+C (or ⌘C).')); }
  } }, 'Copy my progress code');
  const loadBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
    clear(moveMsg);
    let data;
    try { data = parseProgress(codeBox.value); } catch (e) { moveMsg.append(h('span', { class: 'move-err' }, e.message)); return; }
    const count = s => { const n = Object.values(s.lessons).filter(l => l.mastered).length; return `${n} mastered lesson${n === 1 ? '' : 's'}`; };
    const done = mode => { importProgress(data, mode); toast(mode === 'merge' ? 'Progress merged' : 'Progress replaced'); location.hash = '#/profile'; window.dispatchEvent(new HashChangeEvent('hashchange')); };
    moveMsg.append(h('div', { class: 'confirm-box move-confirm' },
      h('strong', {}, `This code holds ${count(data)} and ${data.xp} XP.`),
      h('span', {}, `This browser has ${count(getState())} and ${getState().xp} XP. Merge keeps the furthest progress from both; replace discards this browser's progress.`),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => done('merge') }, 'Merge'),
        h('button', { class: 'btn', type: 'button', onclick: () => done('replace') }, 'Replace'))));
  } }, 'Load a code');
  move.append(codeBox, h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } }, copyBtn, loadBtn), moveMsg);
  page.append(move);

  // reset
  const danger = h('section', { style: { marginTop: '40px', paddingTop: '20px', borderTop: '1px solid var(--line)' } }, h('h2', { style: { fontSize: 'var(--step-1)', marginBottom: '8px' } }, 'Start over'));
  const resetBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
    clear(danger);
    danger.append(h('div', { class: 'confirm-box' }, h('strong', {}, 'Erase all progress in this browser?'), h('span', {}, 'XP, mastery, badges and the review deck will be deleted. This cannot be undone.'),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/profile'; window.dispatchEvent(new HashChangeEvent('hashchange')); } }, 'Keep my progress'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { resetAll(); toast('Progress erased'); location.hash = '#/'; } }, 'Erase everything'))));
  } }, 'Reset progress…');
  danger.append(h('p', { style: { color: 'var(--text-2)' } }, 'Progress is stored only in this browser.'), resetBtn);
  page.append(danger);
  return page;
}

export { PASS_MARK };

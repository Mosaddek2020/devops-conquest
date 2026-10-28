// Lesson page: Learn (lenses) → Practice (lab) → Prove (quiz). Each stage unlocks the next.

import { h, clear } from '../ui/dom.js';
import { renderMarkdown } from '../ui/markdown.js';
import { Replay } from '../ui/replay.js';
import { renderDiagram } from '../ui/diagrams.js';
import '../ui/diagrams-platform.js';
import { Quiz } from '../ui/quiz.js';
import { Lab } from '../lab.js';
import { curriculum } from '../curriculum.js';
import { lessonState, markLens, completeLab, recordQuiz, isUnlocked, nextLessonAfter, currentLessonId, PASS_MARK } from '../store.js';

export function mountEmbeds(container, embeds) {
  for (const slot of container.querySelectorAll('.embed')) {
    const e = embeds[Number(slot.dataset.embed)];
    if (!e) continue;
    try {
      if (e.kind === 'replay') slot.replaceWith(new Replay(e.spec).el);
      else if (e.kind === 'diagram') slot.replaceWith(renderDiagram(e.spec.name));
    } catch (err) {
      console.error(err);
      slot.replaceWith(h('div', { class: 'alert alert-caution' }, `This illustration failed to load: ${err.message}`));
    }
  }
}

const STAGES = [
  { id: 'learn', label: 'Learn', desc: 'Several angles on one idea' },
  { id: 'practice', label: 'Practice', desc: 'A hands-on lab' },
  { id: 'prove', label: 'Prove', desc: `Quiz · ${Math.round(PASS_MARK * 100)}% to pass` },
];

export function renderLesson(id, stage, lensIdx = 0) {
  const lesson = curriculum.byId[id];
  const page = h('div', { class: 'page' });
  if (!lesson) { page.append(h('h1', {}, 'Lesson not found'), h('p', {}, h('a', { href: '#/path' }, 'Back to the path'))); return page; }
  const realm = curriculum.realmOf[id];
  const ls = lessonState(id);

  page.append(h('div', { class: 'lesson-head' },
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/path' }, 'Path'), '/', h('a', { href: `#/realm/${realm.id}` }, `Realm ${realm.n} · ${realm.title}`), '/', h('span', {}, `Lesson ${lesson.index + 1}`)),
    h('h1', {}, lesson.title),
    h('p', { class: 'lede', style: { margin: 0 } }, lesson.summary),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      lesson.boss ? h('span', { class: 'pill pill-accent' }, 'Boss challenge') : null,
      h('span', { class: 'pill' }, `${lesson.minutes || 15} min`),
      ls.mastered ? h('span', { class: 'pill pill-ok' }, ls.testedOut ? 'Tested out' : 'Mastered') : null)));

  if (!isUnlocked(id)) {
    const cur = currentLessonId();
    page.append(h('div', { class: 'locked-note' },
      h('strong', {}, 'This lesson is still locked.'),
      h('span', {}, 'DevOps Conquest is mastery-based: each lesson opens once you have mastered the one before it. That way every new idea sits on solid ground.'),
      cur ? h('a', { class: 'btn btn-primary', href: `#/lesson/${cur}` }, `Go to your current lesson: ${curriculum.byId[cur].title}`) : null));
    return page;
  }

  const canPractice = ls.learned;
  const canProve = ls.learned && ls.lab;
  if (!stage) stage = !ls.learned ? 'learn' : !ls.lab ? 'practice' : 'prove';
  if (stage === 'practice' && !canPractice) stage = 'learn';
  if (stage === 'prove' && !canProve) stage = canPractice ? 'practice' : 'learn';

  const bar = h('div', { class: 'stagebar', role: 'tablist', 'aria-label': 'Lesson stages' });
  STAGES.forEach((s, i) => {
    const done = s.id === 'learn' ? ls.learned : s.id === 'practice' ? ls.lab : ls.quizBest >= PASS_MARK;
    const enabled = s.id === 'learn' || (s.id === 'practice' && canPractice) || (s.id === 'prove' && canProve);
    bar.append(h('button', {
      class: 'stage-tab' + (done ? ' is-done' : ''), type: 'button', role: 'tab', 'aria-selected': String(stage === s.id), disabled: !enabled,
      title: enabled ? '' : (s.id === 'practice' ? 'Read every lens in Learn first' : 'Finish the lab first'),
      onclick: () => { location.hash = `#/lesson/${id}/${s.id}`; },
    }, h('span', { class: 'n' }, done ? '✓' : String(i + 1)), h('span', {}, h('span', { class: 'l' }, s.label), h('span', { class: 'd' }, enabled ? s.desc : (s.id === 'practice' ? 'Unlocks after Learn' : 'Unlocks after Practice')))));
  });
  page.append(bar);

  const body = h('div');
  page.append(body);
  if (stage === 'learn') body.append(renderLearn(lesson, lensIdx));
  if (stage === 'practice') body.append(renderPractice(lesson));
  if (stage === 'prove') body.append(renderProve(lesson));
  return page;
}

function renderLearn(lesson, startIdx) {
  const wrap = h('div', { class: 'learn-grid' });
  const nav = h('nav', { class: 'lens-nav', 'aria-label': 'Lenses' }, h('p', { class: 'eyebrow' }, 'Perspectives'));
  const content = h('article', { 'aria-live': 'polite' });
  const lenses = lesson.lenses;
  if (!lenses.length) { content.append(h('p', {}, 'This lesson has no text yet.')); wrap.append(nav, content); return wrap; }
  let idx = Math.min(startIdx, lenses.length - 1);
  const ls = lessonState(lesson.id);
  const buttons = lenses.map((l, i) => h('button', { class: 'lens-btn' + (ls.lenses.includes(l.id) ? ' is-seen' : ''), type: 'button', onclick: () => show(i) }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, l.label)));
  nav.append(...buttons);

  const show = (i) => {
    idx = i;
    const lens = lenses[i];
    markLens(lesson.id, lens.id, lenses.length);
    buttons.forEach((b, k) => { b.setAttribute('aria-current', String(k === i)); if (lessonState(lesson.id).lenses.includes(lenses[k].id)) b.classList.add('is-seen'); });
    clear(content);
    content.append(h('div', { class: 'lens-kicker' }, h('span', { class: 'eyebrow' }, lens.label), h('span', { class: 'eyebrow' }, `${i + 1} / ${lenses.length}`)));
    content.append(h('h2', { class: 'lens-title' }, lens.title));
    const embeds = [];
    const prose = h('div', { class: 'prose' });
    prose.innerHTML = renderMarkdown(lens.md, embeds);
    mountEmbeds(prose, embeds);
    content.append(prose);
    const learned = lessonState(lesson.id).learned;
    const foot = h('div', { class: 'lens-foot' },
      i > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => { show(i - 1); content.scrollIntoView({ block: 'start' }); } }, `← ${lenses[i - 1].label}`) : h('span'),
      i < lenses.length - 1
        ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { show(i + 1); content.scrollIntoView({ block: 'start' }); } }, `Next: ${lenses[i + 1].label} →`)
        : h('a', { class: 'btn btn-primary', href: `#/lesson/${lesson.id}/practice`, 'aria-disabled': String(!learned) }, learned ? 'Start the hands-on lab →' : 'Read every lens to unlock the lab'));
    content.append(foot);
  };
  wrap.append(nav, content);
  show(idx);
  return wrap;
}

function renderPractice(lesson) {
  if (!lesson.lab) {
    const wrap = h('div', { class: 'locked-note' }, h('strong', {}, 'No lab for this lesson.'), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { completeLab(lesson.id); location.hash = `#/lesson/${lesson.id}/prove`; } }, 'Continue to the quiz →'));
    return wrap;
  }
  const ls = lessonState(lesson.id);
  const lab = new Lab(lesson, {
    already: ls.lab,
    onComplete: () => {
      completeLab(lesson.id);
      // unlock the Prove tab in place without rebuilding the lab
      const tabs = document.querySelectorAll('.stage-tab');
      if (tabs[1]) { tabs[1].classList.add('is-done'); tabs[1].querySelector('.n').textContent = '✓'; }
      if (tabs[2]) { tabs[2].disabled = false; tabs[2].removeAttribute('title'); const d = tabs[2].querySelector('.d'); if (d) d.textContent = STAGES[2].desc; }
    },
  });
  lab.onProceed = () => { location.hash = `#/lesson/${lesson.id}/prove`; };
  setTimeout(() => lab.term.focus(), 50);
  return lab.el;
}

function renderProve(lesson) {
  const wrap = h('div');
  const pool = lesson.quiz || [];
  if (!pool.length) { wrap.append(h('p', {}, 'No quiz for this lesson yet.')); return wrap; }
  const ls = lessonState(lesson.id);
  if (ls.mastered) wrap.append(h('div', { class: 'alert alert-tip', style: { marginBottom: '18px' } }, h('p', { class: 'alert-t' }, 'Already mastered'), h('p', {}, 'Retaking the quiz is great review. Your best score is kept.')));
  const quiz = new Quiz(pool, {
    count: lesson.quizCount || (lesson.boss ? 8 : 5),
    title: lesson.boss ? 'Boss quiz' : 'Mastery check',
    idPrefix: lesson.id,
    onFinish: ({ score, pass, missed, actions, retry }) => {
      recordQuiz(lesson.id, score, missed);
      const next = nextLessonAfter(lesson.id);
      if (pass) {
        if (next) actions.append(h('a', { class: 'btn btn-primary', href: `#/lesson/${next}` }, `Next lesson: ${curriculum.byId[next].title} →`));
        else actions.append(h('a', { class: 'btn btn-primary', href: '#/profile' }, 'You finished the path. See your profile →'));
        actions.append(h('a', { class: 'btn', href: '#/' }, 'Back to the world map'));
      } else {
        actions.append(h('button', { class: 'btn btn-primary', type: 'button', onclick: retry }, 'Try a fresh set of questions'));
        actions.append(h('a', { class: 'btn', href: `#/lesson/${lesson.id}/learn` }, 'Review the lesson'));
      }
    },
  });
  wrap.append(quiz.el);
  return wrap;
}

export { STAGES };

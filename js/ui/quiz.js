// Mastery quiz. Question types:
//   mc      single choice            {q, choices, answer, explain, code?}
//   multi   choose all that apply    {q, choices, answer: [i...], explain}
//   tf      true / false             {q, answer: true|false, explain}
//   order   put steps in order       {q, items: [correct order], explain}
//   type    type the command         {q, accept: [string|RegExp], placeholder?, explain}
//   predict mc with a terminal snippet, same shape as mc plus `code`

import { h, clear, shuffle } from './dom.js';
import { renderInline } from './markdown.js';
import { PASS_MARK } from '../store.js';

function normCmd(s) {
  return s.trim().replace(/^\$\s*/, '').replace(/\s+/g, ' ').replace(/["']/g, '"');
}

export function checkTyped(q, value) {
  const v = normCmd(value);
  return q.accept.some(a => (a instanceof RegExp ? a.test(v) : normCmd(a) === v));
}

export class Quiz {
  constructor(pool, { count = 5, title = 'Mastery check', onFinish, intro = null, passMark = PASS_MARK, idPrefix = '' } = {}) {
    this.pool = pool.map((q, i) => ({ ...q, _id: q.id || `${idPrefix}#${i}` }));
    this.count = Math.min(count, this.pool.length);
    this.title = title;
    this.onFinish = onFinish;
    this.intro = intro;
    this.passMark = passMark;
    this.el = h('div', { class: 'quiz' });
    this.start();
  }

  start() {
    this.questions = shuffle(this.pool).slice(0, this.count).map(q => this.prepare(q));
    this.idx = 0;
    this.results = [];
    this.renderQuestion();
  }

  prepare(q) {
    const p = { ...q };
    if (q.type === 'mc' || q.type === 'predict' || q.type === 'multi') {
      const order = shuffle(q.choices.map((_, i) => i));
      p.view = order.map(i => ({ text: q.choices[i], orig: i }));
    }
    if (q.type === 'tf') p.view = [{ text: 'True', orig: true }, { text: 'False', orig: false }];
    if (q.type === 'order') {
      let o = shuffle(q.items.map((_, i) => i));
      if (o.every((v, i) => v === i) && o.length > 1) o = [o[1], o[0], ...o.slice(2)];
      p.view = o.map(i => ({ text: q.items[i], orig: i }));
    }
    return p;
  }

  progress() {
    return h('div', { class: 'quiz-progress', 'aria-hidden': 'true' }, this.questions.map((_, i) => h('i', { class: i < this.results.length ? (this.results[i] ? 'ok' : 'bad') : i === this.idx ? 'cur' : '' })));
  }

  renderQuestion() {
    clear(this.el);
    const q = this.questions[this.idx];
    this.el.append(h('div', { class: 'quiz-top' }, h('div', {}, h('p', { class: 'eyebrow', style: { margin: 0 } }, this.title), h('span', { style: { color: 'var(--muted)', fontSize: '.9rem' } }, `Question ${this.idx + 1} of ${this.questions.length} · pass mark ${Math.round(this.passMark * 100)}%`)), this.progress()));
    const card = h('div', { class: 'q-card' });
    const qt = h('div', { class: 'q-text', id: `q-${this.idx}` });
    qt.innerHTML = renderInline(q.q);
    card.append(qt);
    if (q.code) card.append(h('pre', { class: 'q-code' }, q.code));
    const feedback = h('div');
    const actions = h('div', { class: 'q-actions' });
    let picked = q.type === 'multi' ? new Set() : null;
    let answered = false;
    const submit = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Check answer');

    const finishQuestion = (ok) => {
      answered = true;
      this.results.push(ok);
      const fb = h('div', { class: 'q-feedback ' + (ok ? 'ok' : 'bad'), role: 'status' });
      fb.append(h('strong', {}, ok ? 'Correct.' : 'Not quite.'));
      if (q.explain) { const e = h('div'); e.innerHTML = renderInline(q.explain); fb.append(e); }
      feedback.append(fb);
      clear(actions);
      const last = this.idx === this.questions.length - 1;
      const next = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { if (last) this.finish(); else { this.idx++; this.renderQuestion(); } } }, last ? 'See results' : 'Next question →');
      actions.append(next);
      next.focus();
      this.el.querySelector('.quiz-progress')?.replaceWith(this.progress());
    };

    if (q.type === 'mc' || q.type === 'predict' || q.type === 'tf' || q.type === 'multi') {
      const box = h('div', { class: 'q-choices', role: q.type === 'multi' ? 'group' : 'radiogroup', 'aria-labelledby': `q-${this.idx}` });
      if (q.type === 'multi') card.append(h('p', { style: { margin: 0, color: 'var(--muted)', fontSize: '.9rem' } }, 'Choose all that apply.'));
      const buttons = q.view.map((c, i) => {
        const b = h('button', { class: 'q-choice', type: 'button', role: q.type === 'multi' ? 'checkbox' : 'radio', 'aria-checked': 'false' }, h('span', { class: 'k' }, String.fromCharCode(65 + i)), h('span', { html: renderInline(String(c.text)) }));
        b.addEventListener('click', () => {
          if (answered) return;
          if (q.type === 'multi') {
            if (picked.has(i)) picked.delete(i); else picked.add(i);
            b.classList.toggle('is-picked'); b.setAttribute('aria-checked', String(picked.has(i)));
            submit.disabled = picked.size === 0;
          } else {
            picked = i;
            for (const o of buttons) { o.classList.remove('is-picked'); o.setAttribute('aria-checked', 'false'); }
            b.classList.add('is-picked'); b.setAttribute('aria-checked', 'true');
            submit.disabled = false;
          }
        });
        return b;
      });
      box.append(...buttons);
      card.append(box);
      submit.addEventListener('click', () => {
        if (answered) return;
        let ok;
        if (q.type === 'multi') {
          const chosen = new Set([...picked].map(i => q.view[i].orig));
          const want = new Set(q.answer);
          ok = chosen.size === want.size && [...want].every(x => chosen.has(x));
          q.view.forEach((c, i) => { if (want.has(c.orig)) buttons[i].classList.add('is-right'); else if (picked.has(i)) buttons[i].classList.add('is-wrong'); });
        } else {
          ok = q.view[picked].orig === q.answer;
          q.view.forEach((c, i) => { if (c.orig === q.answer) buttons[i].classList.add('is-right'); else if (i === picked) buttons[i].classList.add('is-wrong'); });
        }
        buttons.forEach(b => b.setAttribute('disabled', ''));
        finishQuestion(ok);
      });
    }

    if (q.type === 'order') {
      const list = h('ol', { class: 'q-order', 'aria-label': 'Reorder these items' });
      let items = [...q.view];
      const draw = () => {
        clear(list);
        items.forEach((it, i) => {
          list.append(h('li', {}, h('span', { html: renderInline(it.text) }), h('span', { class: 'mv' },
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Move ${it.text} up`, disabled: i === 0 || answered, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); } }, '↑'),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Move ${it.text} down`, disabled: i === items.length - 1 || answered, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); } }, '↓'))));
        });
      };
      draw();
      card.append(h('p', { style: { margin: 0, color: 'var(--muted)', fontSize: '.9rem' } }, 'Use the arrows to put these in the right order (first at the top).'), list);
      submit.disabled = false;
      submit.addEventListener('click', () => {
        if (answered) return;
        const ok = items.every((it, i) => it.orig === i);
        draw();
        [...list.children].forEach((li, i) => li.classList.add(items[i].orig === i ? 'is-right' : 'is-wrong'));
        finishQuestion(ok);
        if (!ok) feedback.querySelector('.q-feedback')?.append(h('div', {}, 'Correct order: ', q.items.map((t, i) => `${i + 1}. ${t}`).join('   ')));
      });
    }

    if (q.type === 'type') {
      const input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder: q.placeholder || 'type the command', 'aria-label': 'Your command', id: `q-input-${this.idx}` });
      card.append(h('label', { class: 'q-type' }, h('span', { style: { color: 'var(--term-dim)' } }, '$'), input));
      input.addEventListener('input', () => { submit.disabled = !input.value.trim(); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value.trim()) submit.click(); });
      submit.addEventListener('click', () => {
        if (answered) return;
        const ok = checkTyped(q, input.value);
        input.disabled = true;
        finishQuestion(ok);
        if (!ok && q.model) feedback.querySelector('.q-feedback')?.append(h('div', {}, 'One correct answer: ', h('code', {}, q.model)));
      });
      setTimeout(() => input.focus(), 30);
    }

    actions.append(submit);
    card.append(feedback, actions);
    this.el.append(card);
  }

  finish() {
    const score = this.results.filter(Boolean).length / this.questions.length;
    const pass = score >= this.passMark - 1e-9;
    const missed = this.questions.filter((_, i) => !this.results[i]);
    clear(this.el);
    const box = h('div', { class: 'quiz-result ' + (pass ? 'pass' : 'fail'), role: 'status' },
      h('p', { class: 'eyebrow', style: { margin: 0 } }, pass ? 'Mastery proven' : 'Not yet mastered'),
      h('div', { class: 'score' }, `${Math.round(score * 100)}%`),
      h('p', { style: { margin: 0, color: 'var(--text-2)' } }, pass
        ? `${this.results.filter(Boolean).length} of ${this.questions.length} correct. You cleared the ${Math.round(this.passMark * 100)}% mastery bar.`
        : `${this.results.filter(Boolean).length} of ${this.questions.length} correct. You need ${Math.round(this.passMark * 100)}% to move on. Review the points below, then try a fresh set of questions.`));
    if (missed.length) {
      const ul = h('ul', { class: 'review-list' });
      for (const q of missed) { const li = h('li'); li.innerHTML = `<strong>${renderInline(q.q)}</strong><br>${renderInline(q.explain || '')}`; ul.append(li); }
      box.append(h('p', { class: 'eyebrow', style: { margin: '8px 0 0' } }, 'Review'), ul);
    }
    const actions = h('div', { class: 'q-actions', style: { justifyContent: 'flex-start' } });
    box.append(actions);
    this.el.append(box);
    this.onFinish?.({ score, pass, missed: missed.map(q => q._id), actions, retry: () => this.start() });
  }
}

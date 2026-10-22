// Interactive terminal bound to a simulator Shell.

import { h, clear } from './dom.js';
import { ansiToHtml } from './ansi.js';
import { completionsFor } from '../sim/complete.js';

export class Terminal {
  constructor(shell, { title = 'terminal', onCommand = null, welcome = [], suggestions = [], onReset = null, height = null } = {}) {
    this.shell = shell;
    this.onCommand = onCommand;
    this.onReset = onReset;
    this.histIdx = null;
    this.draft = '';
    this.busy = false;
    this.el = h('div', { class: 'term', role: 'region', 'aria-label': 'Terminal' });
    if (height) this.el.style.height = height;
    this.titleEl = h('span', { class: 'title' }, title);
    const bar = h('div', { class: 'term-bar' },
      h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      this.titleEl,
      h('button', { type: 'button', onclick: () => this.clearScreen(), title: 'Clear the screen (Ctrl+L)' }, 'clear'),
      onReset ? h('button', { type: 'button', onclick: () => onReset(), title: 'Start this lab again from the beginning' }, 'reset lab') : null);
    this.scroll = h('div', { class: 'term-scroll', 'aria-live': 'polite' });
    this.promptEl = h('span', { class: 'term-prompt' });
    this.input = h('input', {
      class: 'term-input', type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Type a command and press Enter',
      id: 'term-input-' + Math.random().toString(36).slice(2, 8),
    });
    this.input.addEventListener('keydown', e => this.onKey(e));
    const row = h('div', { class: 'term-input-row' }, this.promptEl, this.input);
    this.suggestBox = h('div', { class: 'term-suggest' });
    this.el.append(bar, this.scroll, row, this.suggestBox);
    this.el.addEventListener('click', e => {
      if (window.getSelection()?.toString()) return;
      if (e.target.closest('button, textarea, a')) return;
      this.input.focus({ preventScroll: true });
    });
    for (const w of welcome) this.print(w, 'term-sys');
    this.setSuggestions(suggestions);
    this.updatePrompt();
  }

  setSuggestions(list) {
    clear(this.suggestBox);
    for (const s of list || []) {
      this.suggestBox.append(h('button', { type: 'button', title: 'Put this command in the prompt', onclick: () => { this.input.value = s; this.input.focus(); } }, s));
    }
  }

  promptHtml() {
    if (this.pendingAsk) return `<span class="s">${esc(this.pendingAsk.prompt || '>')}</span> `;
    const p = this.shell.prompt();
    let s = `<span class="${p.root ? 's' : 'u'}">${esc(p.user)}@${esc(p.host)}</span>:<span class="p">${esc(p.path)}</span>`;
    if (p.branch) s += ` <span class="b">(${esc(p.branch)}${p.dirty ? '*' : ''}${p.state ? '|' : ''}</span>${p.state ? `<span class="s">${p.state}</span>` : ''}<span class="b">)</span>`;
    return s + (p.root ? '# ' : '$ ');
  }

  updatePrompt() { this.promptEl.innerHTML = this.promptHtml(); }

  print(text, cls = '') {
    const line = h('div', { class: 'term-line ' + cls });
    line.innerHTML = ansiToHtml(text);
    this.scroll.append(line);
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  clearScreen() { clear(this.scroll); this.input.focus(); }

  focus() { this.input.focus({ preventScroll: true }); }

  run(line, { echo = true } = {}) {
    if (echo) {
      const l = h('div', { class: 'term-line term-echo' });
      l.innerHTML = this.promptHtml() + ansiToHtml(line);
      this.scroll.append(l);
    }
    let res;
    try {
      if (this.pendingAsk) { const req = this.pendingAsk; this.pendingAsk = null; res = this.shell.resolveAsk(req, line); }
      else res = this.shell.run(line);
    } catch (e) {
      console.error(e);
      this.print(`\x1b[31msimulator error: ${e.message}\x1b[0m`);
      res = { out: [], code: 1 };
    }
    this.handleResult(line, res);
  }

  handleResult(line, res) {
    if (res.clear) clear(this.scroll);
    for (const l of res.out) this.print(l);
    this.updatePrompt();
    if (res.editor) { this.openEditor(res.editor, line); return; }
    if (res.ask) { this.pendingAsk = res.ask; this.updatePrompt(); }
    this.scroll.scrollTop = this.scroll.scrollHeight;
    if (this.onCommand) this.onCommand(line, res);
  }

  openEditor(req, line) {
    const ta = h('textarea', { spellcheck: 'false', 'aria-label': `Editing ${req.title}`, id: 'editor-' + Math.random().toString(36).slice(2, 8) });
    ta.value = req.content;
    const close = () => { ed.remove(); this.input.disabled = false; this.focus(); };
    const save = () => {
      const text = ta.value;
      close();
      this.print(`\x1b[2m(saved ${req.title})\x1b[0m`);
      let res;
      try { res = this.shell.resolveEditor(req, text); } catch (e) { console.error(e); res = { out: [`\x1b[31msimulator error: ${e.message}\x1b[0m`], code: 1 }; }
      this.handleResult(line, res);
    };
    const cancel = () => {
      close();
      if (req.file) this.print('\x1b[2m(closed without saving)\x1b[0m');
      else {
        // closing a commit/rebase editor without saving is an empty message
        let res;
        try { res = this.shell.resolveEditor(req, ''); } catch (e) { res = { out: [String(e.message)], code: 1 }; }
        this.handleResult(line, res);
      }
    };
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd); ta.selectionStart = ta.selectionEnd = s + 2; }
    });
    const ed = h('div', { class: 'editor', role: 'dialog', 'aria-label': `Editor: ${req.title}` },
      h('div', { class: 'editor-head' },
        h('span', {}, `✎ ${req.title}`),
        h('span', { class: 'editor-actions' },
          h('button', { type: 'button', class: 'cancel', onclick: cancel }, 'Cancel (Esc)'),
          h('button', { type: 'button', onclick: save }, 'Save (Ctrl+S)')),
        req.hint ? h('span', { class: 'hint' }, req.hint) : null),
      ta);
    this.el.append(ed);
    this.input.disabled = true;
    setTimeout(() => { ta.focus(); if (!req.file) { const firstEmpty = ta.value.indexOf('\n'); if (ta.value.startsWith('\n') || firstEmpty === 0) ta.setSelectionRange(0, 0); } }, 20);
  }

  onKey(e) {
    const hist = this.shell.history;
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = this.input.value;
      this.input.value = '';
      this.histIdx = null;
      this.run(line);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hist.length) return;
      if (this.histIdx === null) { this.draft = this.input.value; this.histIdx = hist.length; }
      this.histIdx = Math.max(0, this.histIdx - 1);
      this.input.value = hist[this.histIdx];
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.histIdx === null) return;
      this.histIdx++;
      if (this.histIdx >= hist.length) { this.histIdx = null; this.input.value = this.draft; }
      else this.input.value = hist[this.histIdx];
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); this.complete(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); this.clearScreen(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
      e.preventDefault();
      const l = h('div', { class: 'term-line term-echo' });
      l.innerHTML = this.promptHtml() + ansiToHtml(this.input.value) + '^C';
      this.scroll.append(l);
      this.input.value = '';
    }
  }

  complete() {
    const v = this.input.value;
    const parts = v.split(/\s+/);
    const cur = parts[parts.length - 1];
    const options = completionsFor(this.shell, parts);
    const matches = [...new Set(options)].filter(o => o.startsWith(cur)).sort();
    if (!matches.length) return;
    if (matches.length === 1) {
      parts[parts.length - 1] = matches[0] + (matches[0].endsWith('/') ? '' : ' ');
      this.input.value = parts.join(' ');
      return;
    }
    let prefix = matches[0];
    for (const m of matches) while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix.length > cur.length) { parts[parts.length - 1] = prefix; this.input.value = parts.join(' '); return; }
    const l = h('div', { class: 'term-line term-echo' });
    l.innerHTML = this.promptHtml() + ansiToHtml(v);
    this.scroll.append(l);
    this.print(matches.slice(0, 60).join('  '));
  }
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

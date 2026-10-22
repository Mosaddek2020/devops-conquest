// A focused Markdown renderer for lesson text. Supports headings, paragraphs, lists,
// tables, fenced code, GitHub-style alerts (> [!TIP]) and two custom fences:
// ```replay (a stepped git animation) and ```diagram (a named illustration).

import { esc } from './dom.js';

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const internal = u.startsWith('#');
    return `<a href="${u}"${internal ? '' : ' target="_blank" rel="noopener"'}>${t}</a>`;
  });
  s = s.replace(/\{kbd:([^}]+)\}/g, '<kbd class="kbd">$1</kbd>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

function renderCode(lang, body) {
  if (['term', 'bash', 'sh', 'console', 'shell'].includes(lang)) {
    const lines = body.split('\n').map(l => {
      if (l.startsWith('$ ')) return `<span class="c-prompt">$ </span><span class="c-cmd">${esc(l.slice(2))}</span>`;
      if (/^\s*#/.test(l)) return `<span class="c-cmt">${esc(l)}</span>`;
      return esc(l);
    });
    return `<pre class="term-block"><code>${lines.join('\n')}</code></pre>`;
  }
  return `<pre><code class="lang-${esc(lang || 'text')}">${esc(body)}</code></pre>`;
}

function parseKV(body) {
  const spec = { steps: [], setup: [] };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'step') {
      const [cmd, ...cap] = v.split(' | ');
      spec.steps.push({ cmd: cmd.trim(), caption: cap.join(' | ').trim() });
    } else if (k === 'setup') spec.setup.push(...v.split(/;\s*/).filter(Boolean));
    else spec[k] = v;
  }
  return spec;
}

export function renderMarkdown(src, embeds = []) {
  const lines = src.replace(/\r/g, '').split('\n');
  let html = '';
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para.length = 0; } };

  while (i < lines.length) {
    const line = lines[i];
    // fenced block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flush();
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      if (lang === 'replay' || lang === 'diagram' || lang === 'try') {
        const spec = lang === 'diagram' ? { name: body.join('\n').trim().split('\n')[0].replace(/^name:\s*/, ''), ...parseKV(body.join('\n')) } : parseKV(body.join('\n'));
        embeds.push({ kind: lang, spec });
        html += `<div class="embed" data-embed="${embeds.length - 1}"></div>`;
      } else html += renderCode(lang, body.join('\n'));
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const hd = line.match(/^(#{2,4})\s+(.*)$/);
    if (hd) { flush(); const n = hd[1].length; html += `<h${n}>${inline(hd[2])}</h${n}>`; i++; continue; }
    if (/^---+\s*$/.test(line)) { flush(); html += '<hr>'; i++; continue; }
    if (line.startsWith('>')) {
      flush();
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) { body.push(lines[i].replace(/^>\s?/, '')); i++; }
      const alert = body[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (alert) {
        const kind = alert[1].toLowerCase();
        const label = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }[kind];
        const rest = [alert[2], ...body.slice(1)].join('\n').trim();
        html += `<div class="alert alert-${kind}" role="note"><p class="alert-t">${label}</p>${renderMarkdown(rest)}</div>`;
      } else html += `<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && lines[i + 1] && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const row = l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      const head = row(line);
      i += 2;
      let t = '<div class="table-wrap"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { t += '<tr>' + row(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++; }
      html += t + '</tbody></table></div>';
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m && m[1].length <= 1) { items.push([m[3]]); i++; continue; }
        if (lines[i].match(/^\s{2,}\S/) && items.length) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>` + items.map(parts => {
        const [first, ...sub] = parts;
        const subList = sub.filter(s => /^([-*]|\d+\.)\s+/.test(s));
        const cont = sub.filter(s => !/^([-*]|\d+\.)\s+/.test(s));
        return `<li>${inline([first, ...cont].join(' '))}${subList.length ? '<ul>' + subList.map(s => `<li>${inline(s.replace(/^([-*]|\d+\.)\s+/, ''))}</li>`).join('') + '</ul>' : ''}</li>`;
      }).join('') + `</${tag}>`;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return html;
}

export { inline as renderInline };

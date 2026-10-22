// A small YAML subset parser: block mappings, block sequences, flow sequences/maps,
// quoted and plain scalars, and literal/folded block scalars (| and >). Enough for
// GitHub workflow files and similar configs. Errors carry the 1-based line number.

export class YamlError extends Error {
  constructor(message, line) { super(line ? `line ${line}: ${message}` : message); this.line = line; }
}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function splitFlow(s) {
  const parts = [];
  let depth = 0, q = null, cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function scalar(raw, line) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError('unclosed [ in flow sequence', line);
    return splitFlow(s.slice(1, -1)).map(p => scalar(p, line));
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new YamlError('unclosed { in flow mapping', line);
    const o = {};
    for (const p of splitFlow(s.slice(1, -1))) {
      const m = p.match(/^([^:]+):\s*(.*)$/);
      if (!m) throw new YamlError(`bad flow mapping entry: ${p}`, line);
      o[unquote(m[1].trim())] = scalar(m[2], line);
    }
    return o;
  }
  if (s.startsWith('"') || s.startsWith("'")) {
    if (s.length < 2 || s[s.length - 1] !== s[0]) throw new YamlError(`unclosed quote: ${s}`, line);
    return unquote(s);
  }
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  return s;
}

// Find "key: value" where the colon is outside quotes and followed by space or end.
function splitKey(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && i === 0) { q = c; continue; }
    if (c === ':' && (i === s.length - 1 || s[i + 1] === ' ')) return [unquote(s.slice(0, i).trim()), s.slice(i + 1)];
    if (c === '[' || c === '{') return null;
  }
  return null;
}

export function parseYaml(text) {
  const lines = [];
  text.split('\n').forEach((raw, i) => {
    if (/^\t| \t/.test(raw.match(/^[\s]*/)[0]) && raw.trim()) throw new YamlError('tabs are not allowed for indentation (use spaces)', i + 1);
    const body = stripComment(raw).replace(/\s+$/, '');
    lines.push({ n: i + 1, raw, indent: raw.match(/^ */)[0].length, text: body.trim(), blank: !body.trim() });
  });
  let pos = 0;
  const next = () => { while (pos < lines.length && lines[pos].blank) pos++; return lines[pos]; };

  function blockScalar(parentIndent, style) {
    const out = [];
    let ind = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.raw.trim() && l.indent <= parentIndent) break;
      if (l.raw.trim()) { if (ind === null) ind = l.indent; out.push(l.raw.slice(ind)); } else out.push('');
      pos++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return style === '|' ? out.join('\n') + '\n' : out.join(' ') + '\n';
  }

  function parseNode(indent) {
    const l = next();
    if (!l || l.indent < indent) return null;
    if (l.text.startsWith('- ') || l.text === '-') return parseSeq(l.indent);
    return parseMap(l.indent);
  }

  function valueAfterKey(rest, keyIndent, line) {
    const v = rest.trim();
    if (v === '|' || v === '>' || v === '|-' || v === '>-') return blockScalar(keyIndent, v[0]);
    if (v !== '') return scalar(v, line);
    const n = next();
    if (!n || n.indent <= keyIndent) {
      // a sequence may sit at the same indent as its key
      if (n && n.indent === keyIndent && (n.text.startsWith('- ') || n.text === '-')) return parseSeq(keyIndent);
      return null;
    }
    return parseNode(n.indent);
  }

  function parseMap(indent) {
    const obj = {};
    while (true) {
      const l = next();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError(`unexpected indentation (expected ${indent} spaces, found ${l.indent})`, l.n);
      if (l.text.startsWith('- ')) break;
      const kv = splitKey(l.text);
      if (!kv) throw new YamlError(`expected "key: value" but found: ${l.text}`, l.n);
      pos++;
      if (kv[0] in obj) throw new YamlError(`duplicate key "${kv[0]}"`, l.n);
      obj[kv[0]] = valueAfterKey(kv[1], indent, l.n);
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (true) {
      const l = next();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError(`unexpected indentation in list (expected ${indent} spaces, found ${l.indent})`, l.n);
      if (!(l.text.startsWith('- ') || l.text === '-')) break;
      const rest = l.text.slice(1).trim();
      const itemIndent = indent + (l.raw.slice(indent).match(/^-\s*/)[0].length);
      if (!rest) { pos++; arr.push(parseNode(indent + 1)); continue; }
      const kv = splitKey(rest);
      if (!kv) { pos++; arr.push(scalar(rest, l.n)); continue; }
      // mapping item: first key is on the dash line, the rest at itemIndent
      const obj = {};
      pos++;
      obj[kv[0]] = valueAfterKey(kv[1], itemIndent, l.n);
      while (true) {
        const n = next();
        if (!n || n.indent !== itemIndent || n.text.startsWith('- ')) {
          if (n && n.indent > itemIndent && !(n.indent === indent)) throw new YamlError(`unexpected indentation (expected ${itemIndent} spaces, found ${n.indent})`, n.n);
          break;
        }
        const kv2 = splitKey(n.text);
        if (!kv2) throw new YamlError(`expected "key: value" but found: ${n.text}`, n.n);
        pos++;
        if (kv2[0] in obj) throw new YamlError(`duplicate key "${kv2[0]}"`, n.n);
        obj[kv2[0]] = valueAfterKey(kv2[1], itemIndent, n.n);
      }
      arr.push(obj);
    }
    return arr;
  }

  const first = next();
  if (!first) return null;
  if (first.indent !== 0) throw new YamlError('the document must start at column 1', first.n);
  const doc = first.text.startsWith('- ') ? parseSeq(0) : (splitKey(first.text) ? parseMap(0) : (pos++, scalar(first.text, first.n)));
  const rest = next();
  if (rest) throw new YamlError(`unexpected content: ${rest.text}`, rest.n);
  return doc;
}

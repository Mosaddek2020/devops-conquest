// Line diffs, unified-diff hunks and a diff3 three-way merge.

export function splitLines(text) {
  if (text === '' || text == null) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Returns a list of ops: {op:'=', a, b} | {op:'-', a} | {op:'+', b} with line indices.
export function diffLines(a, b) {
  const n = a.length, m = b.length;
  // Trim common prefix/suffix so the DP table stays small.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n, endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: '=', a: i, b: i });

  const aa = a.slice(start, endA), bb = b.slice(start, endB);
  const N = aa.length, M = bb.length;
  const dp = Array.from({ length: N + 1 }, () => new Uint16Array(M + 1));
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i][j] = aa[i] === bb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < N || j < M) {
    if (i < N && j < M && aa[i] === bb[j]) { ops.push({ op: '=', a: start + i, b: start + j }); i++; j++; }
    else if (i < N && (j >= M || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ op: '-', a: start + i }); i++; }
    else { ops.push({ op: '+', b: start + j }); j++; }
  }

  for (let k = 0; k < n - endA; k++) ops.push({ op: '=', a: endA + k, b: endB + k });
  return ops;
}

export function diffStats(oldText, newText) {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let add = 0, del = 0;
  for (const o of ops) { if (o.op === '+') add++; else if (o.op === '-') del++; }
  return { add, del };
}

// Unified diff hunks as an array of strings (without the file header).
export function unifiedHunks(oldText, newText, context = 3) {
  const a = splitLines(oldText), b = splitLines(newText);
  const ops = diffLines(a, b);
  const changes = [];
  ops.forEach((o, i) => { if (o.op !== '=') changes.push(i); });
  if (!changes.length) return [];
  const groups = [];
  let gs = changes[0], ge = changes[0];
  for (const c of changes.slice(1)) {
    if (c - ge > context * 2) { groups.push([gs, ge]); gs = c; }
    ge = c;
  }
  groups.push([gs, ge]);

  const out = [];
  for (const [s, e] of groups) {
    const slice = ops.slice(Math.max(0, s - context), Math.min(ops.length, e + context + 1));
    let aStart = null, bStart = null, aLen = 0, bLen = 0;
    const body = [];
    for (const o of slice) {
      if (o.op === '=') { if (aStart === null) aStart = o.a; if (bStart === null) bStart = o.b; aLen++; bLen++; body.push(' ' + a[o.a]); }
      else if (o.op === '-') { if (aStart === null) aStart = o.a; aLen++; body.push('-' + a[o.a]); }
      else { if (bStart === null) bStart = o.b; bLen++; body.push('+' + b[o.b]); }
    }
    if (aStart === null) aStart = firstIndexBefore(slice, 'a');
    if (bStart === null) bStart = firstIndexBefore(slice, 'b');
    const aHead = aLen === 0 ? `${aStart},0` : (aLen === 1 ? `${aStart + 1}` : `${aStart + 1},${aLen}`);
    const bHead = bLen === 0 ? `${bStart},0` : (bLen === 1 ? `${bStart + 1}` : `${bStart + 1},${bLen}`);
    out.push(`@@ -${aHead} +${bHead} @@`);
    out.push(...body);
  }
  return out;
}

function firstIndexBefore(slice, side) {
  // For pure insertions/deletions at a point, git reports the line before.
  for (const o of slice) if (o[side] !== undefined) return o[side];
  return 0;
}

// diff3 merge. Returns {text, conflict:boolean}.
export function merge3(baseText, oursText, theirsText, labels = {}) {
  const base = splitLines(baseText), ours = splitLines(oursText), theirs = splitLines(theirsText);
  const oursLabel = labels.ours || 'HEAD';
  const theirsLabel = labels.theirs || 'theirs';

  const mapO = matchMap(base, ours);
  const mapT = matchMap(base, theirs);

  const result = [];
  let conflict = false;
  let bi = 0, oi = 0, ti = 0;

  const emitChunk = (bEnd, oEnd, tEnd) => {
    const bChunk = base.slice(bi, bEnd), oChunk = ours.slice(oi, oEnd), tChunk = theirs.slice(ti, tEnd);
    if (eq(oChunk, bChunk)) result.push(...tChunk);
    else if (eq(tChunk, bChunk)) result.push(...oChunk);
    else if (eq(oChunk, tChunk)) result.push(...oChunk);
    else {
      conflict = true;
      result.push(`<<<<<<< ${oursLabel}`, ...oChunk, '=======', ...tChunk, `>>>>>>> ${theirsLabel}`);
    }
  };

  for (let k = 0; k <= base.length; k++) {
    const stable = k === base.length || (mapO[k] !== -1 && mapT[k] !== -1 && mapO[k] >= oi && mapT[k] >= ti);
    if (!stable) continue;
    const oEnd = k === base.length ? ours.length : mapO[k];
    const tEnd = k === base.length ? theirs.length : mapT[k];
    if (k > bi || oEnd > oi || tEnd > ti) emitChunk(k, oEnd, tEnd);
    if (k < base.length) result.push(base[k]);
    bi = k + 1; oi = oEnd + 1; ti = tEnd + 1;
  }

  const ends = (t) => t === '' || t.endsWith('\n');
  const trailing = (ends(oursText) || ends(theirsText) || conflict) && result.length ? '\n' : '';
  return { text: result.join('\n') + trailing, conflict };
}

function matchMap(base, other) {
  const map = new Array(base.length).fill(-1);
  for (const o of diffLines(base, other)) if (o.op === '=') map[o.a] = o.b;
  return map;
}

function eq(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

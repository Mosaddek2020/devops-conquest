// SOPS and age: encrypt the values (not the keys) of a YAML file so it can live in git.
// age-keygen makes a key pair; sops encrypts for the public key (from --age or a
// .sops.yaml creation rule) and only someone holding the private key can decrypt. Values
// become ENC[AES256_GCM,…] strings, a MAC detects tampering, and `sops FILE` opens the
// decrypted file in the editor and re-encrypts it on save.

import { def } from './registry.js';
import { parseYaml } from '../git/yaml.js';
import { toYaml } from './kubectl.js';
import { dirname } from './host.js';

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const mix = (s, n) => { let h1 = 0x9e3779b9, h2 = 0x85ebca6b; for (const ch of String(s)) { h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0; h2 = Math.imul(h2 ^ h1, 0x5bd1e995) >>> 0; } let out = ''; for (let i = 0; i < n; i++) { h1 ^= h1 << 13; h1 >>>= 0; h1 ^= h1 >>> 17; h1 ^= h1 << 5; h1 >>>= 0; h2 = (h2 + h1) >>> 0; out += B32[((h1 ^ h2) >>> 0) % 32]; } return out; };
const SECRET_PREFIX = ['AGE', 'SECRET', 'KEY', '1'].join('-');   // assembled at run time
export const publicOf = secret => 'age1' + mix('pub:' + secret, 58);
const newSecret = seed => SECRET_PREFIX + mix('sec:' + seed, 58).toUpperCase();

// keystream cipher: reversible only with the file's data key
const stream = (key, salt, n) => { const out = []; let x = 0; for (const ch of key + salt) x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out.push(x & 255); } return out; };
const enc8 = s => [...new TextEncoder().encode(s)];
const dec8 = b => new TextDecoder().decode(new Uint8Array(b));
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => [...atob(s)].map(c => c.charCodeAt(0));
function encValue(v, key, path) {
  const type = typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : typeof v === 'boolean' ? 'bool' : 'str';
  const pt = enc8(String(v));
  const ks = stream(key, path, pt.length);
  return `ENC[AES256_GCM,data:${b64(pt.map((b, i) => b ^ ks[i]))},iv:${b64(stream(key, 'iv' + path, 12))},tag:${b64(stream(key, 'tag' + path + v, 16))},type:${type}]`;
}
function decValue(s, key, path) {
  const m = String(s).match(/^ENC\[AES256_GCM,data:([^,]*),iv:[^,]*,tag:[^,]*,type:(\w+)\]$/);
  if (!m) return s;
  const ct = unb64(m[1]);
  const ks = stream(key, path, ct.length);
  const t = dec8(ct.map((b, i) => b ^ ks[i]));
  return m[2] === 'int' || m[2] === 'float' ? Number(t) : m[2] === 'bool' ? t === 'true' : t;
}

function walk(o, fn, path = '', top = true, re = null, inside = false) {
  if (Array.isArray(o)) return o.map((x, i) => walk(x, fn, `${path}[${i}]`, false, re, inside));
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => { if (top && k === 'sops') return [k, v]; const enter = inside || !re || re.test(k); return [k, walk(v, fn, `${path}/${k}`, false, re, enter)]; }));
  return inside || !re ? fn(o, path) : o;
}
const stable = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(q => [q, x[q]])) : x);
const macOf = (doc) => mix('mac:' + stable(doc), 40);

function identities(c) {
  const home = c.host.users.get(c.user)?.home || '/root';
  const file = c.env.SOPS_AGE_KEY_FILE ? c.resolve(c.env.SOPS_AGE_KEY_FILE) : `${home}/.config/sops/age/keys.txt`;
  const text = c.env.SOPS_AGE_KEY || c.host.files.get(file);
  if (text === undefined) return { error: `failed to open file: open ${file}: no such file or directory`, file };
  return { keys: String(text).split('\n').map(l => l.trim()).filter(l => l.startsWith(SECRET_PREFIX)), file };
}

function creationRule(c, file) {
  let dir = dirname(c.resolve(file));
  while (true) {
    const t = c.host.files.get(`${dir}/.sops.yaml`);
    if (t !== undefined) {
      let cfg; try { cfg = parseYaml(t) || {}; } catch (e) { return { error: `error loading config: ${e.message}` }; }
      for (const r of cfg.creation_rules || []) if (!r.path_regex || new RegExp(r.path_regex).test(c.resolve(file).slice(dir.length + 1)) || new RegExp(r.path_regex).test(file)) return { rule: r };
      return { error: 'error loading config: no matching creation rules found' };
    }
    if (dir === '/' || !dir) return { rule: null };
    dir = dirname(dir);
  }
}

def('age-keygen', c => {
  const o = c.args;
  if (o[0] === '-y') { const t = c.host.files.get(c.resolve(o[1] || '')); if (t === undefined) return c.fail(`age-keygen: error: failed to open input file "${o[1]}"`, 1); const k = t.split('\n').find(l => l.startsWith(SECRET_PREFIX)); c.print(publicOf(k)); return 0; }
  const outIdx = o.indexOf('-o');
  const secret = newSecret(`${c.uni.time}:${c.host.name}:${(c.uni.ageSeq = (c.uni.ageSeq || 0) + 1)}`);
  const text = `# created: ${new Date(c.uni.time * 1000).toISOString().replace(/\.\d+Z$/, 'Z')}\n# public key: ${publicOf(secret)}\n${secret}\n`;
  if (outIdx >= 0) {
    const p = c.resolve(o[outIdx + 1]);
    if (c.host.files.has(p)) return c.fail(`age-keygen: error: output file "${o[outIdx + 1]}" exists`, 1);
    c.host.ensureParents?.(p, c.user);
    c.host.writeFile(p, text, c.user); c.host.setMeta(p, { mode: 0o600 });
    c.eprint(`Public key: ${publicOf(secret)}`);
  } else c.out(text);
  c.uni.emit({ type: 'age-keygen', host: c.host.name, file: outIdx >= 0 ? c.resolve(o[outIdx + 1]) : null, pub: publicOf(secret) });
  return 0;
}, { pkg: 'age' });

def('sops', c => {
  const args = c.args;
  const flags = {}; const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--age', '--encrypted-regex', '--output', '--input-type', '--output-type', '--extract'].includes(a)) { flags[a] = args[++i]; continue; }
    if (a.startsWith('--') && a.includes('=')) { flags[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1); continue; }
    if (a.startsWith('-')) { flags[a] = true; continue; }
    pos.push(a);
  }
  const mode = flags['--encrypt'] || flags['-e'] ? 'encrypt' : flags['--decrypt'] || flags['-d'] ? 'decrypt' : pos[0] === 'encrypt' || pos[0] === 'decrypt' || pos[0] === 'edit' ? pos.shift() : 'edit';
  if (flags['--version']) { c.print('sops 3.9.1 (latest)'); return 0; }
  const file = pos[0];
  if (!file) return c.fail('Error: no file specified', 1);
  const abs = c.resolve(file);
  const text = c.host.files.get(abs);
  const emit = extra => c.uni.emit({ type: 'sops', host: c.host.name, mode, file: abs, ...extra });
  const writeOut = (s) => { if (flags['--in-place'] || flags['-i']) { c.host.writeFile(abs, s, c.host.stat(abs)?.owner || c.user); } else if (flags['--output']) c.host.writeFile(c.resolve(flags['--output']), s, c.user); else c.out(s); };
  if (mode === 'encrypt') {
    if (text === undefined) return c.fail(`Error: cannot operate on non-existent file`, 1);
    let doc; try { doc = parseYaml(text); } catch (e) { return c.fail(`Error unmarshalling input yaml: ${e.message}`, 128); }
    if (doc?.sops) return c.fail('The file you have provided contains a top-level entry called \'sops\', or for flat file formats top-level entries starting with \'sops_\'. This is generally due to the file already being encrypted with SOPS.', 203);
    const cr = creationRule(c, file);
    if (cr.error) return c.fail(cr.error, 1);
    const recipients = String(flags['--age'] || cr.rule?.age || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!recipients.length) return c.fail('Error: no matching creation rules found', 1);
    if (recipients.some(r => !/^age1[0-9a-z]{58}$/.test(r))) return c.fail(`Error: could not parse age public key: ${recipients.find(r => !/^age1[0-9a-z]{58}$/.test(r))}`, 1);
    const regex = flags['--encrypted-regex'] || cr.rule?.encrypted_regex || null;
    const dataKey = mix(`dk:${abs}:${c.uni.time}`, 32);
    const encDoc = walk(doc, (v, path) => encValue(v, dataKey, path), '', true, regex ? new RegExp(regex) : null);
    encDoc.sops = { age: recipients.map(r => ({ recipient: r, enc: `-----BEGIN AGE ENCRYPTED FILE-----\n${btoa(JSON.stringify({ r: mix('wrap' + r, 8), k: btoa(dataKey) })).match(/.{1,64}/g).join('\n')}\n-----END AGE ENCRYPTED FILE-----\n` })), lastmodified: new Date(c.uni.time * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), mac: encValue(macOf(doc), dataKey, 'mac'), ...(regex ? { encrypted_regex: regex } : {}), version: '3.9.1' };
    writeOut(toYaml(encDoc) + '\n');
    emit({ recipients, inPlace: !!(flags['--in-place'] || flags['-i']) });
    return 0;
  }
  if (text === undefined) return c.fail(`Failed to read "${file}": open ${abs}: no such file or directory`, 1);
  let doc; try { doc = parseYaml(text); } catch (e) { return c.fail(`Error unmarshalling input yaml: ${e.message}`, 128); }
  if (!doc?.sops) return c.fail('sops metadata not found', 100);
  const ids = identities(c);
  const recips = (doc.sops.age || []).map(a => a.recipient);
  const key = ids.keys?.find(k => recips.includes(publicOf(k)));
  if (!key) {
    emit({ ok: false });
    return c.fail(['Failed to get the data key required to decrypt the SOPS file.', '', 'Group 0: FAILED', ...recips.flatMap(r => [`  ${r}: FAILED`, `    - | ${ids.error ? `failed to load age identities: ${ids.error}` : 'no identity matched any of the recipients'}`]), '', 'Recovery failed because no master key was able to decrypt the file. In', 'order for SOPS to recover the file, at least one key has to be successful,', 'but none were.'].join('\n'), 128);
  }
  const wrapped = (doc.sops.age || []).find(a => a.recipient === publicOf(key)).enc;
  const dataKey = atob(JSON.parse(atob(wrapped.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''))).k);
  const regex = doc.sops.encrypted_regex ? new RegExp(doc.sops.encrypted_regex) : null;
  const { sops: meta, ...body } = doc;
  const plain = walk(body, (v, path) => decValue(v, dataKey, path), '', true, regex);
  if (decValue(meta.mac, dataKey, 'mac') !== macOf(plain)) { emit({ ok: false, mac: true }); return c.fail(`Error: MAC mismatch. File has ${macOf(plain).toUpperCase().slice(0, 32)} computed, ${String(decValue(meta.mac, dataKey, 'mac')).toUpperCase().slice(0, 32)} stored`, 51); }
  if (mode === 'decrypt') {
    if (flags['--extract']) { const path = flags['--extract'].match(/\["([^"]+)"\]/g)?.map(s => s.slice(2, -2)) || []; let v = plain; for (const p of path) v = v?.[p]; c.out(String(v) + (c.inPipe ? '' : '\n')); emit({ ok: true }); return 0; }
    writeOut(toYaml(plain) + '\n');
    emit({ ok: true });
    return 0;
  }
  // edit: decrypted in the editor, re-encrypted on save
  c.result.editor = {
    title: abs.split('/').pop(),
    content: toYaml(plain) + '\n',
    onSave(newText, { io }) {
      let nd; try { nd = parseYaml(newText); } catch (e) { io.err(`Error unmarshalling file: ${e.message}\n`); return 1; }
      const encDoc = walk(nd, (v, path) => encValue(v, dataKey, path), '', true, regex);
      encDoc.sops = { ...meta, lastmodified: new Date(c.uni.time * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), mac: encValue(macOf(nd), dataKey, 'mac') };
      c.host.writeFile(abs, toYaml(encDoc) + '\n', c.host.stat(abs)?.owner || c.user);
      c.uni.emit({ type: 'sops', host: c.host.name, mode: 'edit', file: abs, ok: true, saved: true });
      return 0;
    },
  };
  return 0;
}, { pkg: 'sops' });

export { SECRET_PREFIX };

// Imports every module (node --check does not catch everything in ES modules).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('../js/', import.meta.url).pathname;
const files = [];
const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
walk(root);
globalThis.document = globalThis.document || { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, append() {}, setAttribute() {}, addEventListener() {} }), createElementNS: () => ({ append() {}, setAttribute() {} }), addEventListener() {} };
globalThis.window = globalThis.window || globalThis;
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {} };
globalThis.location = globalThis.location || { hash: '' };
let bad = 0;
for (const f of files) { try { await import(f); } catch (e) { if (e instanceof SyntaxError || /Unexpected|Invalid or unexpected|missing/.test(e.message)) { bad++; console.log(`✗ ${f.replace(root, 'js/')}: ${e.message}`); } } }
console.log(bad ? `\n${bad} modules failed to load` : `${files.length} modules load`);
process.exit(bad ? 1 : 0);

// Runs every lab's reference solution through the simulator and checks each task passes,
// and that no task passes before its own steps ran (a sign of a too-loose check).
// Task fields used: `test` (array of steps) or else `solution`. A step is a command
// string, {cmd, edit|edits}, a function t => command, or {act: (H, t) => …}.
import { realms } from '../js/content/index.js';
import { buildLabWorld, makeCheckApi } from '../js/lab.js';
import { stripAnsi } from '../js/git/world.js';

const only = process.argv[2];
const verbose = process.argv.includes('-v');
let failures = 0, labs = 0, warnings = 0;
for (const realm of realms) {
  for (const lesson of realm.lessons) {
    const id = `${realm.id}/${lesson.id}`;
    if (only && only !== '-v' && !id.includes(only)) continue;
    const def = lesson.lab;
    if (!def) continue;
    labs++;
    const { uni, sh, H } = buildLabWorld(def);
    const history = [];
    const api = makeCheckApi(uni, sh, history);
    uni.listeners.clear();
    if (def.events) uni.listeners.add(ev => def.events(ev, { ...H, ...api, say: () => {} }));
    const log = [];
    let ok = true;
    for (let i = 0; i < def.tasks.length; i++) {
      const t = def.tasks[i];
      const steps = t.test || (t.solution ? [t.solution] : []);
      let early = false;
      try { early = !!t.check(api); } catch { early = false; }
      if (early && !t.allowEarly) { console.log(`! ${id} task ${i + 1} passes before its steps run: ${t.title}`); warnings++; }
      for (const step of steps) {
        if (step && step.act) { step.act(H, api); log.push(`[${step.label || 'action'}]`); continue; }
        const s = typeof step === 'string' ? { cmd: step } : typeof step === 'function' ? { cmd: step(api) } : step;
        const edits = s.edits ? [...s.edits] : (s.edit !== undefined ? [s.edit] : []);
        let r = sh.run(s.cmd);
        history.push(s.cmd);
        log.push(`${sh.host.name}$ ${s.cmd}`, ...r.out.map(stripAnsi));
        while (r.editor) {
          const e = edits.shift();
          const text = typeof e === 'function' ? e(r.editor.content) : (e ?? r.editor.content);
          r = sh.resolveEditor(r.editor, text);
          log.push(`  [saved ${r.editor?.title || 'editor'}]`, ...r.out.map(stripAnsi));
        }
        while (r.ask) { const a = (s.answers || ['yes']).shift() ?? 'yes'; r = sh.resolveAsk(r.ask, a); log.push(`  [answered ${a}]`, ...r.out.map(stripAnsi)); }
        def.onCommand?.(s.cmd, r, { ...H, ...api, say: () => {} });
      }
      let pass = false;
      try { pass = !!t.check(api); } catch (e) { log.push('check threw: ' + e.message); }
      if (!pass) { ok = false; console.log(`✗ ${id} task ${i + 1}: ${t.title}`); console.log(log.slice(-30).map(l => '    ' + l).join('\n')); break; }
    }
    if (ok) console.log(`✓ ${id} (${def.tasks.length} tasks)`); else failures++;
    if (verbose && ok) console.log(log.map(l => '    ' + l).join('\n'));
  }
}
console.log(`\n${labs - failures}/${labs} labs solvable, ${warnings} premature-pass warnings`);
process.exit(failures ? 1 : 0);

// GitHub Actions jobs on simulated runner machines. Each job gets a fresh Ubuntu runner:
// actions/checkout writes the repository into the workspace, run: steps execute in bash
// (bash -e, like GitHub), secrets arrive as environment variables, and artifacts pass
// between jobs. Deploy steps really ssh/scp to the lab's servers; smoke tests really curl.

import { Session } from './session.js';
import { installPkg } from './packages.js';
import { stripAnsi } from '../git/world.js';

let runnerSeq = 0;

export function installRunner(uni, addServer) {
  uni.realRunner = ({ world, bare, run, job, flat, base, interpolate, evalExpr, truthy }) => {
    const def = job.def;
    const name = `runner-${++runnerSeq}`;
    const h = addServer(uni, name, { user: 'runner', ip: `10.9.${Math.floor(runnerSeq / 250)}.${runnerSeq % 250 + 2}` });
    h.hidden = true;
    for (const p of ['git', 'nodejs', 'npm', 'jq']) installPkg(h, uni, p, []);
    if (uni.dockerInstall) installPkg(h, uni, 'docker.io', []);
    const repoName = bare.meta.name;
    const ws = `/home/runner/work/${repoName}/${repoName}`;
    h.mkdirMeta(ws, 'runner');
    job.log = [`Runner: ${def.runsOn} (${name}, ${h.ip})`];
    if (job.approval) job.log.push(`Deployment to ${job.envName} approved by ${job.approval.by}`);
    run.artifacts = run.artifacts || {};
    let ok = true;
    try {
      for (const s of def.steps) {
        const label = s.name || (s.uses ? `Run ${s.uses}` : `Run ${s.run.split('\n')[0]}`);
        if (s.if) {
          let c;
          try { c = truthy(evalExpr(s.if, { ...base, __status: ok ? 'success' : 'failure' })); } catch (e) { job.log.push(`${label}: error in if: ${e.message}`); ok = false; break; }
          if (!c) { job.log.push(`${label} (skipped)`); continue; }
        } else if (!ok) break;
        const w = {};
        try { for (const [k, v] of Object.entries(s.with || {})) w[k] = interpolate(v ?? '', base); } catch (e) { job.log.push(`${label}: ${e.message}`); ok = false; break; }
        if (s.uses) {
          job.log.push(`▸ ${label}`);
          const action = s.uses.split('@')[0];
          if (action === 'actions/checkout') {
            for (const [p, hash] of flat) h.writeFile(`${ws}/${p}`, world.objects.get(hash).content, 'runner');
            if (flat.has('scripts/deploy.sh') || [...flat.keys()].some(p => p.endsWith('.sh'))) for (const [p] of flat) if (p.endsWith('.sh')) h.setMeta(`${ws}/${p}`, { mode: 0o755 });
            job.log.push(`  Checked out ${bare.meta.owner}/${repoName} @ ${run.hash.slice(0, 7)} into ${ws}`);
          } else if (action === 'actions/setup-node') job.log.push(`  Node.js ${w['node-version'] || '20'} ready`);
          else if (action === 'actions/upload-artifact') {
            const nm = w.name || 'artifact';
            const target = w.path || '.';
            const abs = target.startsWith('/') ? target : `${ws}/${target}`;
            const files = {};
            for (const [p, c] of h.files) if (p === abs || p.startsWith(abs.replace(/\/$/, '') + '/')) files[p === abs ? p.split('/').pop() : p.slice(abs.replace(/\/$/, '').length + 1)] = c;
            if (!Object.keys(files).length) { job.log.push(`  Error: No files were found with the provided path: ${target}. No artifacts will be uploaded.`); ok = false; break; }
            run.artifacts[nm] = files;
            job.log.push(`  Uploaded artifact "${nm}" (${Object.keys(files).length} files)`);
          } else if (action === 'actions/download-artifact') {
            const nm = w.name || 'artifact';
            const files = run.artifacts[nm];
            if (!files) { job.log.push(`  Error: Unable to download artifact(s): Artifact not found for name: ${nm}`); ok = false; break; }
            const dest = w.path ? (w.path.startsWith('/') ? w.path : `${ws}/${w.path}`) : ws;
            for (const [p, c] of Object.entries(files)) h.writeFile(`${dest}/${p}`, c, 'runner');
            job.log.push(`  Downloaded artifact "${nm}" to ${dest}`);
          } else job.log.push('  (action simulated)');
          continue;
        }
        let env;
        try {
          env = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_SHA: run.hash, GITHUB_REF: base.github.ref, GITHUB_REF_NAME: run.branch, GITHUB_REPOSITORY: `${bare.meta.owner}/${repoName}`, GITHUB_RUN_NUMBER: String(run.id), GITHUB_WORKSPACE: ws, RUNNER_OS: 'Linux' };
          for (const src of [run.wf.env, def.env, s.env]) for (const [k, v] of Object.entries(src || {})) env[k] = interpolate(v ?? '', base);
        } catch (e) { job.log.push(`${label}: ${e.message}`); ok = false; break; }
        let script;
        try { script = interpolate(s.run, base); } catch (e) { job.log.push(`Error in expression: ${e.message}`); ok = false; break; }
        job.log.push(`▸ ${label}`);
        const sh = new Session(uni, h, { user: 'runner', cwd: s['working-directory'] ? `${ws}/${s['working-directory']}` : ws });
        sh.advancePerCommand = 0;
        for (const [k, v] of Object.entries(env)) sh.setVar(sh.e, k, v, { exported: true });
        sh.e.opts.e = true;
        sh.e.interactive = false;
        const chunks = [];
        const code = sh.runScript(script, sh.e, { in: null, out: x => chunks.push(x), err: x => chunks.push(x) }, { name: 'step', result: { editor: null } });
        let out = stripAnsi(chunks.join('')).replace(/\n$/, '');
        // GitHub masks secret values in logs
        for (const v of Object.values(base.secrets || {})) if (v && v !== '***' && String(v).length >= 4) for (const part of String(v).split('\n').filter(x => x.trim().length >= 4)) out = out.split(part).join('***');
        if (out) job.log.push(...out.split('\n').map(l => '  ' + l));
        if (code !== 0) { job.log.push(`  Error: Process completed with exit code ${code}.`); ok = false; break; }
      }
    } finally {
      uni.hosts.delete(name);
      uni.byIp.delete(h.ip);
      uni.dns.delete(name);
    }
    job.status = 'completed';
    job.conclusion = ok ? 'success' : 'failure';
    job.ok = ok;
  };
}

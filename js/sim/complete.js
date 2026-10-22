// Tab completion: command names, subcommands of common tools, git refs, and paths.

import { registry, commandAvailable } from './registry.js';
import { SHELL_BUILTINS } from './session.js';
import { commands as gitCommands } from '../git/git.js';
import { branchNames } from '../git/core.js';

const SUBS = {
  systemctl: ['start', 'stop', 'restart', 'reload', 'status', 'enable', 'disable', 'is-active', 'is-enabled', 'daemon-reload', 'list-units', 'cat'],
  apt: ['update', 'install', 'remove', 'upgrade', 'list', 'search', 'show'],
  ufw: ['status', 'enable', 'disable', 'allow', 'deny', 'delete', 'default', 'reset'],
  gh: ['pr', 'issue', 'repo', 'release', 'run', 'workflow', 'secret', 'auth'],
  docker: ['build', 'run', 'ps', 'images', 'logs', 'exec', 'stop', 'start', 'rm', 'rmi', 'pull', 'push', 'tag', 'inspect', 'network', 'volume', 'compose', 'system', 'login', 'stats', 'history', 'scout'],
  kubectl: ['get', 'describe', 'apply', 'delete', 'logs', 'exec', 'rollout', 'scale', 'set', 'create', 'expose', 'port-forward', 'top', 'config', 'edit', 'label', 'explain', 'events', 'auth', 'cordon', 'drain', 'uncordon'],
  terraform: ['init', 'plan', 'apply', 'destroy', 'fmt', 'validate', 'output', 'state', 'show', 'import', 'workspace', 'console', 'refresh'],
  helm: ['install', 'upgrade', 'rollback', 'list', 'uninstall', 'history', 'template', 'repo', 'show', 'status'],
};

export function completionsFor(sh, parts) {
  const cur = parts[parts.length - 1];
  const host = sh.host;
  if (parts.length === 1) {
    const names = [...Object.keys(SHELL_BUILTINS), ...Object.keys(registry).filter(n => commandAvailable(host, n) && !n.includes('_')), ...Object.keys(sh.extraCommands || {})];
    if (cur.startsWith('.') || cur.startsWith('/')) return paths(sh, cur);
    return names;
  }
  const cmd = parts[0] === 'sudo' ? parts[1] : parts[0];
  const argIdx = parts[0] === 'sudo' ? parts.length - 2 : parts.length - 1;
  if (cmd === 'git' && argIdx === 1) return Object.keys(gitCommands);
  if (SUBS[cmd] && argIdx === 1) return SUBS[cmd];
  const out = [];
  if (cmd === 'git') {
    const repo = sh.repo;
    if (repo) {
      out.push(...branchNames(repo), ...Object.keys(repo.refs).filter(r => r.startsWith('refs/remotes/')).map(r => r.slice(13)), ...Object.keys(repo.refs).filter(r => r.startsWith('refs/tags/')).map(r => r.slice(10)));
    }
  }
  if (cmd === 'systemctl' || cmd === 'journalctl') out.push(...[...host.units.keys()].map(u => u.replace(/\.service$/, '')));
  if (cmd === 'ssh' || cmd === 'ping' || cmd === 'scp') out.push(...[...sh.uni.hosts.keys()]);
  out.push(...paths(sh, cur));
  return out;
}

function paths(sh, cur) {
  const slash = cur.lastIndexOf('/');
  const dirPart = slash >= 0 ? cur.slice(0, slash + 1) : '';
  const abs = sh.resolvePath(dirPart || '.');
  if (!sh.host.isDir(abs)) return [];
  return sh.host.listDir(abs).map(([n, kind]) => dirPart + n + (kind === 'dir' ? '/' : ''));
}

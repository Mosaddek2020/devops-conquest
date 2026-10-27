// The SSH server's effective settings, read from /etc/ssh/sshd_config and its drop-ins.

const SSHD_KEYS = new Set(['port', 'listenaddress', 'hostkey', 'permitrootlogin', 'passwordauthentication', 'pubkeyauthentication', 'kbdinteractiveauthentication', 'challengeresponseauthentication', 'usepam', 'x11forwarding', 'printmotd', 'acceptenv', 'subsystem', 'include', 'allowusers', 'allowgroups', 'denyusers', 'maxauthtries', 'logingracetime', 'clientaliveinterval', 'clientalivecountmax', 'permitemptypasswords', 'allowtcpforwarding', 'allowagentforwarding', 'authorizedkeysfile', 'loglevel', 'maxsessions', 'protocol', 'usedns', 'banner', 'match', 'ciphers', 'macs', 'kexalgorithms']);
export function sshdConfig(host) {
  const files = ['/etc/ssh/sshd_config', ...[...host.files.keys()].filter(p => p.startsWith('/etc/ssh/sshd_config.d/') && p.endsWith('.conf')).sort()];
  const cfg = {};
  const errors = [];
  // first value wins, and drop-ins (included at the top on Ubuntu) come first
  for (const f of [...files.slice(1), files[0]]) {
    const text = host.files.get(f);
    if (text === undefined) continue;
    text.split('\n').forEach((l, i) => {
      const m = l.replace(/#.*/, '').trim().match(/^(\S+)\s+(.+)$/);
      if (!m) return;
      const k = m[1].toLowerCase();
      if (!SSHD_KEYS.has(k)) { errors.push(`${f}: line ${i + 1}: Bad configuration option: ${m[1]}`); return; }
      if (k === 'permitrootlogin' && !/^(yes|no|prohibit-password|without-password|forced-commands-only)$/.test(m[2].trim())) errors.push(`${f} line ${i + 1}: unsupported option "${m[2].trim()}".`);
      if (['passwordauthentication', 'pubkeyauthentication', 'permitemptypasswords'].includes(k) && !/^(yes|no)$/.test(m[2].trim())) errors.push(`${f} line ${i + 1}: unsupported option "${m[2].trim()}".`);
      if (!(k in cfg)) cfg[k] = m[2].trim();
    });
  }
  return { cfg: { permitrootlogin: 'prohibit-password', passwordauthentication: 'yes', ...cfg }, errors };
}

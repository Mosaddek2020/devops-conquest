// Lab helpers and checks for the Infrastructure as Code realm.

import { registerLabExtension } from '../labext.js';
import { installCloud } from './cloud.js';
import { installPkg } from './packages.js';

export const LAPTOP_PUBLIC_IP = '198.51.100.23';

registerLabExtension({
  helpers: (uni, sh, H) => ({
    // an AWS-like account plus credentials and tools on the laptop
    cloud(opts = {}) {
      const cloud = installCloud(uni, opts);
      const laptop = uni.host('laptop');
      for (const p of opts.tools || ['awscli', 'terraform']) installPkg(laptop, uni, p, []);
      laptop.publicIp = LAPTOP_PUBLIC_IP;
      H.write('laptop', '~/.aws/credentials', '[default]\naws_access_key_id = AKIAZ3EXAMPLEQX7A\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEh3Kd\n', { owner: 'dev', mode: 0o600 });
      H.write('laptop', '~/.aws/config', `[default]\nregion = ${cloud.region}\noutput = json\n`, { owner: 'dev' });
      if (!uni.ipHook) { uni.ipHook = true; uni.httpHooks.push(({ url, from }) => /^(ifconfig\.me|checkip\.amazonaws\.com|api\.ipify\.org)$/.test(url.host) ? { status: 200, headers: { 'content-type': 'text/plain' }, body: (from.publicIp || from.ip) + '\n' } : null); }
      return cloud;
    },
    // somebody changes the cloud by hand (console click-ops) during a lab
    clickops(fn) { fn(uni.cloud); },
    tfLock(bucketKey, who = 'priya@priya-laptop') { uni.tfLocks = { ...(uni.tfLocks || {}), [bucketKey]: { id: '6c1f2a0e-93b4-d5e2-41f8-0b7a9c3e5d21', who, op: 'OperationTypeApply', time: uni.time - 1800 } }; },
  }),
  checks: (uni, sh, api) => ({
    cloud: () => uni.cloud,
    cres: (type, pred = () => true) => uni.cloud ? uni.cloud.all(type).filter(pred) : [],
    tfstate: (dir) => { const t = api.file('laptop', `${dir}/terraform.tfstate`); try { return t ? JSON.parse(t) : null; } catch { return null; } },
    tfran: (pred) => api.events('terraform').some(pred),
  }),
});

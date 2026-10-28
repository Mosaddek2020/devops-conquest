// Lab helpers and checks for disks, mounts and performance troubleshooting.

import { registerLabExtension } from '../labext.js';
import { storageOf, addDisk, findDev, mountFor, mountsOf, parseFstab } from './storage.js';
import { perfHost, perfStats } from './perf.js';

registerLabExtension({
  helpers: (uni, sh, H) => ({
    // an extra block device: H.disk('web1', { name: 'xvdf', sizeGB: 50 }) (fs/mount optional)
    disk(on, opts) { return addDisk(H.host(on), opts); },
    // a performance model for a host (load average follows its processes)
    perf(on, opts) { return perfHost(uni, H.host(on), opts); },
  }),
  checks: (uni, sh, api) => ({
    dev: (on, name) => findDev(storageOf(api.host(on)), name),
    mountedAt: (on, path) => { const h = api.host(on); return h.mountTable?.find(m => m.mount === path) || null; },
    mountOf: (on, path) => mountFor(storageOf(api.host(on)), path),
    fsUsage: (on, path) => mountsOf(storageOf(api.host(on))).find(m => m.mount === path) || null,
    fstab: on => parseFstab(api.host(on).files.get('/etc/fstab')),
    perfNow: on => perfStats(api.host(on)),
  }),
});

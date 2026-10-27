// Simulator entry point: importing this registers every command.
import './cmd/core.js';
import './cmd/text.js';
import './cmd/jq.js';
import './cmd/logrotate.js';
import './cmd/system.js';
import './cmd/net.js';
import './cmd/gitcmd.js';
import './systemd.js';
import './ai.js';
import './docker.js';
import './docker-lab.js';
import './kubectl.js';
import './k8s-lab.js';
import './cloud.js';
import './terraform.js';
import './ansible.js';
import './obs.js';
import './obs-lab.js';
import './reliability.js';
import './security.js';
import './aiops.js';
import './iac-lab.js';
import { wirePackages } from './packages.js';
import { installSystemdTicker } from './systemd.js';

wirePackages();

export { Universe, Host, SimError } from './host.js';
export { Session } from './session.js';
export { registry } from './registry.js';
export { installSystemdTicker };
export { CATALOG, UBUNTU_BASE, installPkg } from './packages.js';

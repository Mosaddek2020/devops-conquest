// Simulator entry point: importing this registers every command.
import './cmd/core.js';
import './cmd/text.js';
import './cmd/jq.js';
import './cmd/system.js';
import './cmd/net.js';
import './cmd/gitcmd.js';
import './systemd.js';
import './ai.js';
import { wirePackages } from './packages.js';
import { installSystemdTicker } from './systemd.js';

wirePackages();

export { Universe, Host, SimError } from './host.js';
export { Session } from './session.js';
export { registry } from './registry.js';
export { installSystemdTicker };
export { CATALOG, UBUNTU_BASE, installPkg } from './packages.js';

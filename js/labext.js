// Lab extensions: later simulators (containers, Kubernetes, cloud, metrics, AI) add lab
// helpers and check functions here so lab.js stays small.
export const labExtensions = [];
export function registerLabExtension(ext) { labExtensions.push(ext); }

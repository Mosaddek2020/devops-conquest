// Extra lab panels registered by simulators: name -> { label, create({ onAction, lab }) }
export const extraPanels = {};
export function registerPanel(name, label, create) { extraPanels[name] = { label, create }; }

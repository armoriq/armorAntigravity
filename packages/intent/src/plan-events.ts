// Own tools run in the daemon. This signal carries no plan or conversation data.
const listeners = new Set<() => void>();

export function onPlanSuccess(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitPlanSuccess(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* Reporting must never change a plan reply. */ }
  }
}

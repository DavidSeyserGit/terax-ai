/**
 * One-shot password store keyed by terminal tab id. Lives outside React so the
 * password never lands in component state, devtools, or persisted snapshots.
 *
 * The terminal pane consumes (and removes) the password the first time the
 * remote `password:` prompt appears; the SFTP bridge consumes its own copy
 * when it kicks off the parallel connection. Both consumers receive the value
 * immediately and the slot is wiped, so the lifetime is bounded by a single
 * login attempt.
 */
const pending = new Map<number, string>();

export function setPendingSshPassword(tabId: number, password: string): void {
  pending.set(tabId, password);
}

export function consumePendingSshPassword(tabId: number): string | undefined {
  const v = pending.get(tabId);
  pending.delete(tabId);
  return v;
}

export function clearPendingSshPassword(tabId: number): void {
  pending.delete(tabId);
}

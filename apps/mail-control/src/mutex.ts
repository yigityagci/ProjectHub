/**
 * A single global mutex covering every MUTATING operation
 * (`/v1/config/apply`, `/v1/reload`, `/v1/test-email`). At most one
 * mutating operation may be in flight at a time in this process — a
 * second concurrent attempt gets `409 OPERATION_IN_PROGRESS` immediately
 * rather than queuing, because two interleaved `postconf`/staging-dir
 * writes against the same `/etc/postfix.staging` directory would corrupt
 * it. In-memory (not Redis/a DB lock): this listener is a single,
 * non-replicated process by construction (co-located with Postfix's own
 * master process in one container) — see apps/mail-control's top-level
 * design notes.
 */
let locked = false;

export function tryAcquire(): boolean {
  if (locked) return false;
  locked = true;
  return true;
}

export function release(): void {
  locked = false;
}

export function isLocked(): boolean {
  return locked;
}

/** Test-only: force the mutex back to unlocked between test cases. */
export function resetForTests(): void {
  locked = false;
}

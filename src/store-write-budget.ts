/**
 * Time budgets around the global `store-write` lock (distill-lock.ts, a kernel flock). Kept in a
 * module of its own so the HTTP servers (gateway-server.ts proxies writes but never opens the
 * store) can size their timeouts from the same numbers. store.ts re-exports the lock options.
 */

/**
 * Options for every `store-write` critical section (store.ts, checkpoint-mirror.ts). Nobody can take
 * the lock from a live holder; it is freed the moment the holder exits or is killed. `maxHoldMs`
 * only raises the stuck-holder warning. Waiters wait at least as long as a normal hold may last:
 * with a shorter budget (the old 10 s default against 30 s holds) a waiter throws while a healthy
 * holder is still inside its own window.
 */
export const STORE_WRITE_LOCK_OPTS = { maxHoldMs: 30_000, waitTimeoutMs: 30_000 } as const;

/**
 * For the singleton version-group pass, which scans the whole table under the lock: same wait
 * budget, but it may legitimately hold for longer, so it only counts as stuck after 30 minutes —
 * at which point it stops at the next batch boundary (see repairSingletonVersionGroups).
 */
export const STORE_WRITE_LONG_LOCK_OPTS = { maxHoldMs: 30 * 60_000, waitTimeoutMs: 30_000 } as const;

/**
 * Minimum wait for any OTHER lock whose critical section may itself take store-write: the holder
 * of the outer lock can be waiting up to STORE_WRITE_LOCK_OPTS.waitTimeoutMs for store-write and
 * then doing its write. An outer wait shorter than that times out while the holder is healthy and
 * drops the second caller's write (checkpoint-mirror, session-distiller).
 */
export const STORE_WRITE_NESTED_WAIT_MS = STORE_WRITE_LOCK_OPTS.waitTimeoutMs + 30_000;

/**
 * Bun.serve `idleTimeout` (seconds; Bun's maximum is 255) for servers that run or proxy writes. Bun's
 * default is 10 s; a write request can wait up to STORE_WRITE_LOCK_OPTS.waitTimeoutMs for store-write
 * before it even starts, so with the default the client's connection is dropped while the handler
 * still commits. This leaves room for that wait plus embedding and the write itself.
 */
export const HTTP_WRITE_IDLE_TIMEOUT_S = Math.ceil((STORE_WRITE_LOCK_OPTS.waitTimeoutMs + 45_000) / 1000);

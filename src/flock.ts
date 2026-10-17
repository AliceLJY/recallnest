/**
 * Kernel advisory file locks (flock(2)) reached through bun:ffi, for distill-lock.ts.
 *
 * Why the kernel: a flock belongs to an open file description, and the kernel drops it when the
 * last descriptor closes — including when the holding process exits or is SIGKILLed. So "is the
 * holder still alive" is answered by the kernel, and nobody ever has to decide that a lock is
 * stale and take it away from its holder.
 *
 * Only `flock(int, int)` and the errno accessor are called; both are non-variadic, so the FFI
 * signatures below match the C ABI on x86-64 and arm64 alike (fcntl/open are variadic and would
 * not be safe to declare this way on Apple arm64, which passes variadic arguments on the stack).
 *
 * - Linux (glibc): `flock` and `__errno_location` in libc.so.6. LOCK_EX=2, LOCK_NB=4, LOCK_UN=8,
 *   EWOULDBLOCK=EAGAIN=11, EINTR=4, O_CLOEXEC=0o2000000.
 * - macOS: `flock` and `__error` in libSystem.B.dylib (served from the dyld shared cache, so
 *   dlopen by its install name works without the file on disk). Same LOCK_* values
 *   (<sys/fcntl.h>), EWOULDBLOCK=EAGAIN=35, EINTR=4, O_CLOEXEC=0x01000000.
 */

import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { constants, openSync } from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EINTR = 4;

interface Platform {
  libPath: string;
  errnoSymbol: "__errno_location" | "__error";
  ewouldblock: number;
  oCloexec: number;
}

function platform(): Platform {
  if (process.platform === "linux") {
    return { libPath: "libc.so.6", errnoSymbol: "__errno_location", ewouldblock: 11, oCloexec: 0o2000000 };
  }
  if (process.platform === "darwin") {
    return { libPath: "/usr/lib/libSystem.B.dylib", errnoSymbol: "__error", ewouldblock: 35, oCloexec: 0x01000000 };
  }
  throw new Error(`cross-process locks need flock(2); platform '${process.platform}' is not supported`);
}

interface Flock {
  flock: (fd: number, op: number) => number;
  errno: () => number;
  ewouldblock: number;
  oCloexec: number;
}

let loaded: Flock | null = null;

function lib(): Flock {
  if (loaded) return loaded;
  const p = platform();
  const handle = dlopen(p.libPath, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [p.errnoSymbol]: { args: [], returns: FFIType.ptr },
  });
  const symbols = handle.symbols as unknown as Record<string, (...args: number[]) => unknown>;
  const flockFn = symbols.flock!;
  const errnoFn = symbols[p.errnoSymbol]!;
  loaded = {
    flock: (fd, op) => flockFn(fd, op) as number,
    errno: () => read.i32(errnoFn() as Pointer, 0),
    ewouldblock: p.ewouldblock,
    oCloexec: p.oCloexec,
  };
  return loaded;
}

/**
 * Open (creating if needed) a lock file for reading and writing, close-on-exec so a child
 * process can never inherit the descriptor and with it the lock.
 */
export function openLockFile(path: string): number {
  return openSync(path, constants.O_RDWR | constants.O_CREAT | lib().oCloexec, 0o644);
}

/** Non-blocking exclusive flock. true = acquired, false = another open file description holds it. */
export function tryLockExclusive(fd: number): boolean {
  const l = lib();
  for (;;) {
    if (l.flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
    // Read errno immediately: nothing runs between the FFI return and this call.
    const errno = l.errno();
    if (errno === l.ewouldblock) return false;
    if (errno === EINTR) continue;
    throw new Error(`flock(LOCK_EX|LOCK_NB) failed on fd ${fd}: errno ${errno}`);
  }
}

/** Explicit unlock. Closing the descriptor also unlocks; this is for clarity before close. */
export function unlockFd(fd: number): void {
  lib().flock(fd, LOCK_UN);
}

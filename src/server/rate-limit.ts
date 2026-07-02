/**
 * In-memory fixed-window rate limiter. Suitable for a single-container
 * deployment (SPEC §6); revisit if the app ever runs more than one instance.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 15 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (entry.resetAt <= now) windows.delete(key);
  }
}

/** Returns true when the call is allowed; false when the key is over budget. */
export function checkRateLimit(key: string, limit: number): boolean {
  if (windows.size > 10_000) sweep();
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

export function resetRateLimit(key: string) {
  windows.delete(key);
}

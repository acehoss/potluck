/**
 * Idempotency key for money/inventory mutations, generated once per sheet
 * open. The submit buttons' disabled={isPending} re-renders asynchronously,
 * so a fast double-tap (or a retry after a lost response) can dispatch two
 * mutates; the server dedupes on this key and replays the original result.
 * crypto.randomUUID is unavailable in non-secure contexts (slice-1 lesson:
 * families hit LAN IPs over plain http), hence the fallback.
 */
export function newClientKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

/**
 * Username / slug derivation (REWORK A2/E2). Usernames are the login identity
 * — unique per instance, conservative charset so `user@instance` addressing
 * works at federation time. Slugs are the household handle, same rules.
 * Until dedicated signup fields exist (R1S2+), both are derived server-side:
 * usernames from the email local-part, slugs from the household name.
 */

export const USERNAME_PATTERN = /^[a-z0-9_-]{3,30}$/;

/** Sanitize free text toward [a-z0-9_-], capped so a dedupe suffix still fits. */
function sanitizeHandle(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  const base = cleaned.length >= 3 ? cleaned : `${cleaned}${cleaned ? '-' : ''}${fallback}`;
  return base.slice(0, 24);
}

/** Base username candidate from an email's local part (e.g. "a.b+c@x" → "a-b-c"). */
export function usernameBaseFromEmail(email: string): string {
  return sanitizeHandle(email.split('@')[0] ?? '', 'user');
}

/** Base slug candidate from a household name (e.g. "In-Laws" → "in-laws"). */
export function slugBaseFromName(name: string): string {
  return sanitizeHandle(name, 'household');
}

/**
 * First available handle: the base itself, then base-2, base-3, … Run inside
 * the same dbTransaction as the create so the check-then-act is race-free
 * under the app-wide DB lock.
 */
export async function firstAvailableHandle(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (!(await isTaken(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(`No available handle for base "${base}"`);
}

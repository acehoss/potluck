/**
 * US phone helpers (Profile-polish round, D2). Pure, dependency-free — the phone
 * keypad on mobile blocks `(` and `-`, so the profile input formats digits as you
 * type. NANP (North American Numbering Plan) only: a 10-digit national number, or
 * 11 digits with a leading country-code `1`. Anything that can't be a US number is
 * returned untouched so international numbers survive as free text.
 */

/** True when the raw string opens with `+` (ignoring leading whitespace). */
function hasLeadingPlus(raw: string): boolean {
  return /^\s*\+/.test(raw);
}

/**
 * As-you-type US formatter. Strips non-digits, then formats progressively:
 * `(913` → `(913)` → `(913) 555` → `(913) 555-0142`, and `1 (913) 555-0142` when
 * the digits are 11 with a leading `1` (country code). Returns `raw` UNCHANGED
 * when it cannot be a US number — a leading `+` that isn't `+1`, more than 11
 * digits, 11 digits not starting with `1`, or no digits at all — so free-text
 * international numbers pass through intact.
 */
export function formatUsPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const plus = hasLeadingPlus(raw);

  // Not formattable as US → leave the user's text alone.
  if (digits.length === 0) return raw;
  if (plus && !digits.startsWith('1')) return raw; // +44…, +33…
  if (digits.length > 11) return raw; // too long for NANP
  if (digits.length === 11 && !digits.startsWith('1')) return raw;

  const hasCountry = digits.length === 11; // implies a leading 1 given the checks above
  const core = hasCountry ? digits.slice(1) : digits; // 0..10 national digits
  const area = core.slice(0, 3);
  const mid = core.slice(3, 6);
  const last = core.slice(6, 10);

  let nat: string;
  if (core.length <= 2) nat = `(${area}`;
  else if (core.length === 3) nat = `(${area})`;
  else if (core.length <= 6) nat = `(${area}) ${mid}`;
  else nat = `(${area}) ${mid}-${last}`;

  return hasCountry ? `1 ${nat}` : nat;
}

/**
 * Digits only, preserving a single leading `+` (country-code intent). Used to
 * inspect what a free-text phone string actually contains.
 */
export function phoneDigits(raw: string): string {
  return (hasLeadingPlus(raw) ? '+' : '') + raw.replace(/\D/g, '');
}

/**
 * Normalize a phone string to an E.164-ish value for `tel:`/`sms:` hrefs and the
 * vCard TEL line. A leading `+` is honored as-is (`+` + its digits); a bare
 * 10-digit number gets a US `+1`; 11 digits starting with `1` become `+…`;
 * anything else falls back to its bare digits. Empty input yields `''`.
 */
export function phoneHref(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (hasLeadingPlus(raw)) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

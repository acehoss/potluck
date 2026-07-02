/** Money is integer cents everywhere (SPEC §6). Shared client/server helpers. */

export function formatCents(cents: number) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parse a dollars string ("86.02", "$86.02", "86") to integer cents.
 * Returns null when unparseable.
 */
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [dollars, frac = ''] = cleaned.split('.');
  return Number(dollars) * 100 + Number((frac + '00').slice(0, 2));
}

/** Render integer cents as a plain dollars string for input values ("86.02"). */
export function centsToDollarsString(cents: number) {
  return (cents / 100).toFixed(2);
}

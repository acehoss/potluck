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

/**
 * Split `totalCents` across `weights` into integer cents that sum EXACTLY to
 * `totalCents` (largest-remainder / Hamilton method): floor each proportional
 * share, then hand the leftover pennies to the largest fractional remainders.
 * Zero-weight entries always get 0. Used to distribute receipt tax across
 * taxable lines and fees across all lines (money is integer cents — never a
 * float, never a per-line round that drifts off the receipt total).
 */
export function apportionCents(totalCents: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (totalCents === 0 || sumW <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / sumW);
  const result = exact.map((x) => Math.floor(x));
  let remainder = totalCents - result.reduce((a, b) => a + b, 0);
  // Distribute leftover pennies to the largest fractional parts; only entries
  // with positive weight are eligible (a 0-weight line never earns tax/fee).
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x), w: weights[i] }))
    .filter((e) => e.w > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    result[order[k].i] += 1;
  }
  return result;
}

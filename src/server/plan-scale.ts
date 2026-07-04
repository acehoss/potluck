/**
 * Pure amount math for Round 4 (REWORK H2). No db, no I/O — the per-instance
 * ingredient SCALING used at shopping-list generation and the conservative
 * MERGE helper that folds same-unit lines together. Kept separate from the
 * routers so it is unit-testable in isolation (plan-scale.unit.test.ts).
 *
 * This ports the display-time scaler from src/app/recipes/scale.ts (G1) so the
 * planner scales amounts exactly the way the recipe view shows them. The parse
 * is deliberately conservative: only a leading numeric token (unicode fraction,
 * mixed number, simple fraction, decimal, integer) is understood; anything else
 * ("a pinch", "to taste", a "2-3" range) passes through UNSCALED and merges as
 * an opaque string — never guessed at, mirroring H2's "no cross-unit math".
 */

const UNICODE_FRACTIONS: Record<string, number> = {
  '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4,
  '⅐': 1 / 7, '⅑': 1 / 9, '⅒': 1 / 10,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅕': 1 / 5, '⅖': 2 / 5, '⅗': 3 / 5, '⅘': 4 / 5,
  '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
};
const UNI = Object.keys(UNICODE_FRACTIONS).join('');

/** Read a leading quantity token; returns its value and the raw text consumed. */
function parseLeading(input: string): { value: number; raw: string } | null {
  const s = input.replace(/^\s+/, '');
  let m: RegExpMatchArray | null;
  // integer glued/spaced to a unicode fraction: "1½", "1 ½"
  if ((m = s.match(new RegExp(`^(\\d+)\\s*([${UNI}])`)))) {
    return { value: Number(m[1]) + UNICODE_FRACTIONS[m[2]], raw: m[0] };
  }
  // a lone unicode fraction: "½"
  if ((m = s.match(new RegExp(`^([${UNI}])`)))) {
    return { value: UNICODE_FRACTIONS[m[1]], raw: m[0] };
  }
  // mixed number: "1 1/2"
  if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)/))) {
    return { value: Number(m[1]) + Number(m[2]) / Number(m[3]), raw: m[0] };
  }
  // simple fraction: "1/2"
  if ((m = s.match(/^(\d+)\/(\d+)/))) {
    return { value: Number(m[1]) / Number(m[2]), raw: m[0] };
  }
  // decimal: "1.5"
  if ((m = s.match(/^(\d+\.\d+)/))) {
    return { value: Number(m[1]), raw: m[0] };
  }
  // plain integer: "2"
  if ((m = s.match(/^(\d+)/))) {
    return { value: Number(m[1]), raw: m[0] };
  }
  return null;
}

/** Render a number as a kitchen-friendly whole + simple fraction. */
export function formatQuantity(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  if (frac < 0.02) return String(whole);

  let best: { num: number; den: number; err: number } | null = null;
  for (const den of [2, 3, 4, 6, 8]) {
    const num = Math.round(frac * den);
    if (num <= 0 || num >= den) continue;
    const err = Math.abs(frac - num / den);
    if (!best || err < best.err) best = { num, den, err };
  }
  if (best && best.err < 0.03) {
    const fracStr = `${best.num}/${best.den}`;
    return whole > 0 ? `${whole} ${fracStr}` : fracStr;
  }
  return String(Math.round(n * 100) / 100);
}

/**
 * The numeric value of an amount string, but ONLY when the whole trimmed string
 * is a single quantity token — "2", "1 1/2", "½", "1.5" parse; "2-3", "a splash",
 * "1 to 2" return null (they merge as opaque strings). This whole-string rule is
 * what keeps a range from being summed as just its first number.
 */
export function parseAmountValue(amount: string | null | undefined): number | null {
  if (amount == null) return null;
  const trimmed = amount.trim();
  if (!trimmed) return null;
  const parsed = parseLeading(trimmed);
  if (!parsed || parsed.raw.length !== trimmed.length) return null;
  return parsed.value;
}

/**
 * Scale one amount string by `factor` for a planned instance's servings. Blank
 * amounts, a factor of 1, and amounts whose leading token doesn't parse come
 * back UNCHANGED (H2: never invent a scaled number we can't stand behind). A
 * leading token followed by more text (e.g. a "2-3" range) scales only the
 * leading number, matching the recipe view's display scaler exactly.
 */
export function scaleAmount(amount: string, factor: number): string {
  const trimmed = amount.trim();
  if (!trimmed || factor === 1) return amount;
  const parsed = parseLeading(trimmed);
  if (!parsed) return amount;
  const rest = trimmed.slice(parsed.raw.length);
  return `${formatQuantity(parsed.value * factor)}${rest}`;
}

/**
 * Conservative merge of the amount strings collected under one
 * (normalizedName, unit) key (H2). Fully-numeric amounts SUM into one rendered
 * quantity; everything else is kept verbatim and appended. Unit is NOT part of
 * this string — the caller stores it in its own column (the merge partition) and
 * the UI renders `amounts` beside it. Returns null when nothing meaningful was
 * contributed (e.g. a bare planner "item" with no amount).
 */
export function mergeAmounts(amounts: (string | null | undefined)[]): string | null {
  let sum = 0;
  let hasNumeric = false;
  const opaque: string[] = [];
  for (const a of amounts) {
    if (a == null) continue;
    const trimmed = a.trim();
    if (!trimmed) continue;
    const v = parseAmountValue(trimmed);
    if (v !== null) {
      sum += v;
      hasNumeric = true;
    } else {
      opaque.push(trimmed);
    }
  }
  const parts: string[] = [];
  if (hasNumeric) parts.push(formatQuantity(sum));
  parts.push(...opaque);
  return parts.length ? parts.join(' + ') : null;
}

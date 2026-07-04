/**
 * Display-time ingredient scaling (G1). Parses the leading numeric/fraction of
 * an amount string, multiplies by the serving factor, and re-renders it as a
 * sensible fraction — never mutating the stored text. Amounts whose leading
 * token doesn't parse (e.g. "a pinch", "to taste") come back flagged `approx`
 * so the caller can mark them unscaled.
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
function formatQty(n: number): string {
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
 * Scale one amount string by `factor`. When the factor is 1 or the amount is
 * blank the original is returned untouched; when the leading token can't be
 * parsed the original is returned with `approx: true` so the UI can mark it.
 */
export function scaleAmount(amount: string, factor: number): { display: string; approx: boolean } {
  const trimmed = amount.trim();
  if (!trimmed || factor === 1) return { display: amount, approx: false };
  const parsed = parseLeading(trimmed);
  if (!parsed) return { display: amount, approx: true };
  const rest = trimmed.slice(parsed.raw.length);
  return { display: `${formatQty(parsed.value * factor)}${rest}`, approx: false };
}

/**
 * Pure heuristics for Round 3 recipes (REWORK G4). No db, no I/O — the
 * paste-to-parse assist and the ingredient-name normalizer, kept separate from
 * the router so they are unit-testable in isolation (recipe-parse.unit.test.ts).
 *
 * The parser is ASSIST, never authority: the user reviews everything in the
 * editor, so the contract is "never throws — worst case every line lands as a
 * bare item." Nothing here parses amounts numerically; `amount` stays raw text
 * (scaling is a display concern, G1).
 */

export interface ParsedIngredient {
  kind: 'item' | 'heading';
  amount?: string;
  unit?: string;
  /** Ingredient name for kind=item; the heading text for kind=heading. */
  text: string;
  note?: string;
}

export interface ParsedRecipe {
  ingredients: ParsedIngredient[];
  directions?: string;
}

/**
 * The normalized key an ingredient line maps to for IngredientLink lookup (G2):
 * lower-cased, whitespace-collapsed, trimmed. Deliberately NOT amount/unit
 * stripping — the caller passes the line's `text` field, which is already the
 * name.
 */
export function normalizeIngredientName(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Vulgar/unicode fraction glyphs a pasted recipe may use in place of "1/2".
const UNICODE_FRACTIONS = '¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞';

/**
 * One numeric quantity token, most-specific alternative first so "1 1/2" reads
 * as a mixed number rather than a bare "1". Covers: integer glued/spaced to a
 * unicode fraction ("1½", "1 ½"), a lone unicode fraction ("½"), a mixed number
 * ("1 1/2"), a simple fraction ("1/2"), a decimal ("1.5"), and a plain integer.
 */
const NUMBER = `\\d+\\s*[${UNICODE_FRACTIONS}]|[${UNICODE_FRACTIONS}]|\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+\\.\\d+|\\d+`;
// A range separator: hyphen (ASCII/en/em dash) or the word "to".
const RANGE = `\\s*(?:-|–|—|to)\\s*`;
const AMOUNT = `(?:${NUMBER})(?:${RANGE}(?:${NUMBER}))?`;
/**
 * A leading amount is only an INGREDIENT amount when the number is followed by
 * whitespace, end-of-string, or a unicode fraction — never by "." or ")", which
 * mark a numbered direction step ("1. Preheat…") we must not mistake for a
 * quantity.
 */
const LEADING_AMOUNT = new RegExp(`^\\s*(${AMOUNT})(?=\\s|$|[${UNICODE_FRACTIONS}])`);

/**
 * Known measurement units (lower-cased, singular/plural/abbrev). A first token
 * after the amount is treated as the unit only when it's in this set — anything
 * else (e.g. "large", "ripe") stays part of the ingredient name.
 */
const KNOWN_UNITS = new Set<string>([
  'cup', 'cups', 'c',
  'tablespoon', 'tablespoons', 'tbsp', 'tbsps', 'tbs', 'tbl',
  'teaspoon', 'teaspoons', 'tsp', 'tsps',
  'ounce', 'ounces', 'oz',
  'pound', 'pounds', 'lb', 'lbs',
  'gram', 'grams', 'g',
  'kilogram', 'kilograms', 'kg',
  'milliliter', 'milliliters', 'millilitre', 'millilitres', 'ml',
  'liter', 'liters', 'litre', 'litres', 'l',
  'pint', 'pints', 'pt',
  'quart', 'quarts', 'qt',
  'gallon', 'gallons', 'gal',
  'can', 'cans',
  'jar', 'jars',
  'clove', 'cloves',
  'pinch', 'pinches',
  'dash', 'dashes',
  'stick', 'sticks',
  'package', 'packages', 'pkg', 'pkgs', 'pkt',
  'slice', 'slices',
  'piece', 'pieces',
  'bunch', 'bunches',
  'head', 'heads',
  'sprig', 'sprigs',
  'stalk', 'stalks',
  'handful', 'handfuls',
]);

/**
 * A short section heading: a line ending in ':' or one written in ALL CAPS
 * (letters present, none lower-case). Returns the heading text (colon stripped),
 * or null when the line isn't a heading. A leading-digit line is never a heading
 * (it's a quantity or a numbered step).
 */
function asHeading(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  if (/^\d/.test(t)) return null;
  if (t.endsWith(':') && t.length <= 60) return t.slice(0, -1).trim();
  if (t.length <= 40 && /[A-Za-z]/.test(t) && !/[a-z]/.test(t)) return t;
  return null;
}

/**
 * Pull a note out of an ingredient's name portion: a parenthetical anywhere, or
 * failing that the part after the first comma ("flour, sifted" → text "flour",
 * note "sifted").
 */
function splitNote(rest: string): { text: string; note?: string } {
  let text = rest.trim();
  let note: string | undefined;
  const paren = text.match(/\(([^)]*)\)/);
  if (paren) {
    note = paren[1].trim() || undefined;
    text = (text.slice(0, paren.index) + text.slice(paren.index! + paren[0].length)).replace(/\s+/g, ' ').trim();
  }
  if (!note) {
    const comma = text.indexOf(',');
    if (comma >= 0) {
      note = text.slice(comma + 1).trim() || undefined;
      text = text.slice(0, comma).trim();
    }
  }
  return { text, note };
}

/**
 * Parse a single line into an ingredient (or heading). Order: heading first,
 * then leading amount + optional known unit, then note extraction. Falls back to
 * a bare item — never throws.
 */
export function parseIngredientLine(line: string): ParsedIngredient {
  const heading = asHeading(line);
  if (heading !== null) return { kind: 'heading', text: heading };

  const m = LEADING_AMOUNT.exec(line);
  if (!m) {
    const { text, note } = splitNote(line);
    return { kind: 'item', text: text || line.trim(), note };
  }

  const amount = m[1].replace(/\s+/g, ' ').trim();
  let rest = line.slice(m[0].length).trim();
  let unit: string | undefined;
  const firstTok = rest.match(/^(\S+)/);
  if (firstTok) {
    const tok = firstTok[1].replace(/[.,]+$/, '').toLowerCase();
    if (KNOWN_UNITS.has(tok)) {
      unit = firstTok[1].replace(/[.,]+$/, '');
      rest = rest.slice(firstTok[1].length).trim();
    }
  }
  const { text, note } = splitNote(rest);
  return { kind: 'item', amount, unit, text: text || rest, note };
}

/** A prose (sentence-shaped) line: not a heading, no ingredient amount, long. */
function isProseLine(line: string): boolean {
  if (asHeading(line)) return false;
  const looksNumberedStep = /^\s*\d+\s*[.)]/.test(line); // "1. …" / "2) …"
  if (!looksNumberedStep && LEADING_AMOUNT.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean).length;
  return line.length > 45 || words > 8;
}

/** A blank-line-separated block reads as directions when most of it is prose. */
function isDirectionsBlock(lines: string[]): boolean {
  const prose = lines.filter(isProseLine).length;
  return prose >= Math.ceil(lines.length / 2);
}

/**
 * The paste-to-parse assist (G4): split a blob into ingredient lines and, when
 * present, a trailing prose block returned as `directions`. Blocks are split on
 * blank lines; a block whose lines don't look like ingredients (long sentences)
 * becomes directions, everything else parses line-by-line into ingredients.
 */
export function parseRecipeText(input: string): ParsedRecipe {
  const blocks = (input ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length > 0);

  const ingredientLines: string[] = [];
  const directionBlocks: string[] = [];
  for (const block of blocks) {
    if (isDirectionsBlock(block)) directionBlocks.push(block.join('\n'));
    else ingredientLines.push(...block);
  }

  return {
    ingredients: ingredientLines.map(parseIngredientLine),
    directions: directionBlocks.length ? directionBlocks.join('\n\n') : undefined,
  };
}

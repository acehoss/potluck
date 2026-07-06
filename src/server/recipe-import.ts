/**
 * Recipe URL import (REWORK G4). Fetches a page server-side and pulls a
 * schema.org/Recipe out of it (JSON-LD first, microdata-lite next, a text
 * heuristic last). ADVISORY like extraction.ts: every failure degrades to
 * { status: 'unavailable', reason } — this module never throws to the caller,
 * and the user reviews whatever comes back in the editor.
 *
 * SSRF is the load-bearing risk: the server fetches an arbitrary user-supplied
 * URL, so an unguarded fetch is a blind SSRF primitive into the deployment's
 * network (cloud metadata, LAN, sibling containers). The guard mirrors
 * push-endpoint.ts: https only, no credentials, no IP literals, no
 * localhost/.local/.internal/.home.arpa/dotless hosts, port 443 only — enforced
 * on the initial URL AND re-validated on every redirect hop. Plus: 5s timeout,
 * ≤3 redirects, ≤2MB read, text/html or application/ld+json only.
 *
 * The recipe's photo IS fetched (REWORK R3), through the SAME SSRF guard: the
 * ordered image candidates (JSON-LD `image`, then og:image, then twitter:image)
 * are tried in turn by `guardedImageFetch` — image/* content-type, ≤4MB, and a
 * hard JPEG magic-byte (FF D8) check on the downloaded bytes. There are no server
 * image libraries (deliberate), so the download is JPEG-only: a non-JPEG source
 * image simply yields no stored photo (photoUrl is still returned so the editor
 * can note it). The first candidate that validates is written under the "recipes"
 * kind and surfaced as `photoPath`.
 */

import { parseIngredientLine, parseRecipeText, type ParsedIngredient } from './recipe-parse';
import { writeImageFile } from './images';

export interface ImportedRecipe {
  title?: string;
  description?: string;
  ingredients: ParsedIngredient[];
  directions?: string;
  servings?: number;
  yieldText?: string;
  prepMinutes?: number;
  cookMinutes?: number;
  /** The source image URL (first usable candidate) — display/reference only. */
  photoUrl?: string;
  /**
   * A stored "recipes/<hex>.jpg" path when the source photo was downloaded and
   * validated as JPEG, else null. Only set on the network path
   * (`importRecipeFromUrl`); `extractRecipe` alone leaves it undefined.
   */
  photoPath?: string | null;
  sourceUrl: string;
}

export type ImportResult =
  | { status: 'ok'; data: ImportedRecipe }
  | { status: 'unavailable'; reason: string };

const MAX_BYTES = 2 * 1024 * 1024;
/** Photos run bigger than pages; still bounded so one import can't fill the volume. */
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

/**
 * SSRF guard (shared shape with push-endpoint.ts). Returns the parsed URL when
 * it is safe to fetch, else null. Applied to the initial URL and re-applied to
 * every redirect target.
 */
export function safeImportUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:') return null;
  if (url.port !== '' && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[')) return null; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null; // IPv4 literal
  if (!host.includes('.')) return null; // bare intranet names
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    return null;
  }
  return url;
}

/** Read a response body, capped at `cap` bytes; decoded UTF-8 (never throws). */
async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return new TextDecoder().decode(buf.subarray(0, cap));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  reader.cancel().catch(() => {});
  const merged = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    if (off >= merged.length) break;
    const take = Math.min(c.length, merged.length - off);
    merged.set(c.subarray(0, take), off);
    off += take;
  }
  return new TextDecoder().decode(merged);
}

type FetchOk = { body: string; contentType: string };

/** Fetch with the SSRF guard re-checked on each hop, a timeout, and size caps. */
async function guardedFetch(start: URL): Promise<FetchOk | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = start;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/ld+json',
          'user-agent': 'PotluckRecipeImport/1.0',
        },
      });

      // Redirect: undici exposes the 3xx status + Location under manual mode;
      // a browser-style opaque redirect (status 0) can't be re-validated, so
      // it's refused rather than blindly followed.
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        if (redirects === MAX_REDIRECTS) return { error: 'Too many redirects.' };
        const loc = res.headers.get('location');
        if (!loc) return { error: 'The site returned an unusable redirect.' };
        let next: URL;
        try {
          next = new URL(loc, url);
        } catch {
          return { error: 'The site returned an unusable redirect.' };
        }
        const safe = safeImportUrl(next.href);
        if (!safe) return { error: 'The site redirected somewhere that cannot be fetched.' };
        url = safe;
        continue;
      }

      if (!res.ok) return { error: `The site responded ${res.status}.` };
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('application/ld+json')) {
        return { error: "That link doesn't look like a recipe page." };
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        return { error: 'That page is too large to import.' };
      }
      const body = await readCapped(res, MAX_BYTES);
      return { body, contentType };
    }
    return { error: 'Too many redirects.' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { error: 'The site took too long to respond.' };
    }
    return { error: 'Could not reach that site.' };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body as raw bytes, capped at `cap` (never throws). */
async function readCappedBytes(res: Response, cap: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, cap);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, cap);
}

/**
 * Download one candidate image through the SAME SSRF guard as guardedFetch
 * (safe-URL + hop re-validation + timeout), but for images: image/* only,
 * ≤4MB, and a hard JPEG magic-byte (FF D8) check on the bytes. Returns the JPEG
 * buffer, or null for anything that fails the guard / isn't a fetchable JPEG.
 * Never throws — a bad candidate just yields null and the caller tries the next.
 */
export async function guardedImageFetch(rawUrl: string): Promise<Buffer | null> {
  const start = safeImportUrl(rawUrl);
  if (!start) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = start;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'image/*', 'user-agent': 'PotluckRecipeImport/1.0' },
      });

      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        if (redirects === MAX_REDIRECTS) return null;
        const loc = res.headers.get('location');
        if (!loc) return null;
        let next: URL;
        try {
          next = new URL(loc, url);
        } catch {
          return null;
        }
        const safe = safeImportUrl(next.href);
        if (!safe) return null;
        url = safe;
        continue;
      }

      if (!res.ok) return null;
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('image/')) return null;
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) return null;
      const buf = await readCappedBytes(res, IMAGE_MAX_BYTES);
      // JPEG-only: the server has no image libraries to re-encode anything else.
      if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
      return buf;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Try image candidates in order; return the first that downloads as a JPEG. */
export async function downloadFirstJpeg(candidates: string[]): Promise<Buffer | null> {
  for (const c of candidates) {
    const buf = await guardedImageFetch(c);
    if (buf) return buf;
  }
  return null;
}

// ---- HTML / schema.org helpers (pure) ---------------------------------------

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&#x27;': "'", '&#x2F;': '/',
};

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?\w+;/g, (e) => ENTITIES[e.toLowerCase()] ?? ENTITIES[e] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) {
    for (const e of v) {
      const s = firstString(e);
      if (s) return s;
    }
  }
  return undefined;
}

function isoDurationToMinutes(v: unknown): number | undefined {
  const s = firstString(v);
  if (!s) return undefined;
  const m = s.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return undefined;
  const total =
    (Number(m[1]) || 0) * 1440 +
    (Number(m[2]) || 0) * 60 +
    (Number(m[3]) || 0) +
    Math.round((Number(m[4]) || 0) / 60);
  return total > 0 ? total : undefined;
}

function parseYield(v: unknown): { servings?: number; yieldText?: string } {
  const val = Array.isArray(v) ? v.find((x) => x != null) : v;
  if (val == null) return {};
  if (typeof val === 'number' && Number.isFinite(val)) {
    const s = Math.round(val);
    return s >= 1 ? { servings: s } : {};
  }
  if (typeof val === 'string') {
    const t = val.trim();
    const num = t.match(/\d+/);
    const servings = num ? Number(num[0]) : undefined;
    return { servings: servings && servings >= 1 ? servings : undefined, yieldText: t || undefined };
  }
  return {};
}

function flattenInstructions(v: unknown): string | undefined {
  const steps: string[] = [];
  const visit = (x: unknown) => {
    if (x == null) return;
    if (typeof x === 'string') {
      const t = stripTags(x);
      if (t) steps.push(t);
      return;
    }
    if (Array.isArray(x)) {
      x.forEach(visit);
      return;
    }
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o.itemListElement) return visit(o.itemListElement);
      const t = firstString(o.text) ?? firstString(o.name);
      if (t) steps.push(stripTags(t));
    }
  };
  visit(v);
  return steps.length ? steps.join('\n') : undefined;
}

function firstImageUrl(v: unknown): string | undefined {
  const pick = (x: unknown): string | undefined => {
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) {
      for (const e of x) {
        const u = pick(e);
        if (u) return u;
      }
      return undefined;
    }
    if (x && typeof x === 'object') {
      const u = (x as Record<string, unknown>).url;
      if (typeof u === 'string') return u;
    }
    return undefined;
  };
  const u = pick(v);
  return u && /^https:\/\//i.test(u) ? u : undefined;
}

/** Every image URL reachable through a JSON-LD `image` value (strings + {url}). */
function allImageUrls(v: unknown): string[] {
  const out: string[] = [];
  const visit = (x: unknown) => {
    if (typeof x === 'string') {
      if (x.trim()) out.push(x.trim());
      return;
    }
    if (Array.isArray(x)) return x.forEach(visit);
    if (x && typeof x === 'object') {
      const u = (x as Record<string, unknown>).url;
      if (typeof u === 'string' && u.trim()) out.push(u.trim());
    }
  };
  visit(v);
  return out;
}

/** `<meta property|name="…" content="…">` values for the given keys, doc order. */
function metaContents(html: string, keys: string[]): string[] {
  const out: string[] = [];
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (!key || !keys.includes(key)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim();
    if (content) out.push(content);
  }
  return out;
}

/** Resolve a possibly-relative image URL against the page and keep https only. */
function resolveHttps(raw: string, base: string): string | undefined {
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ordered, de-duplicated, https-resolved photo candidates for a page: the
 * JSON-LD recipe node's `image` first (all of them), then og:image, then
 * twitter:image. Relative URLs resolve against `sourceUrl`. Pure (no network) —
 * both `extractRecipe` (photoUrl = first) and the download loop use it.
 */
export function recipeImageCandidates(
  body: string,
  contentType: string,
  sourceUrl: string,
): string[] {
  const blocks = contentType.includes('application/ld+json')
    ? (() => {
        try {
          return [JSON.parse(body)];
        } catch {
          return [];
        }
      })()
    : jsonLdBlocks(body);

  const raw: string[] = [];
  const node = recipeFromJsonLd(blocks);
  if (node?.image != null) raw.push(...allImageUrls(node.image));
  raw.push(...metaContents(body, ['og:image', 'og:image:url', 'og:image:secure_url']));
  raw.push(...metaContents(body, ['twitter:image', 'twitter:image:src']));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const resolved = resolveHttps(r, sourceUrl);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

function isRecipeType(t: unknown): boolean {
  if (typeof t === 'string') return t.toLowerCase() === 'recipe';
  if (Array.isArray(t)) return t.some(isRecipeType);
  return false;
}

/** Every object node reachable through arrays and @graph containers. */
function collectNodes(json: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (v && typeof v === 'object') {
      out.push(v as Record<string, unknown>);
      const graph = (v as Record<string, unknown>)['@graph'];
      if (graph) visit(graph);
    }
  };
  visit(json);
  return out;
}

function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // A malformed block is skipped — advisory contract, never throws.
    }
  }
  return out;
}

function recipeFromJsonLd(blocks: unknown[]): Record<string, unknown> | null {
  for (const block of blocks) {
    for (const node of collectNodes(block)) {
      if (isRecipeType(node['@type'])) return node;
    }
  }
  return null;
}

function htmlTitle(html: string): string | undefined {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    const t = stripTags(title[1]);
    if (t) return t;
  }
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = stripTags(h1[1]);
    if (t) return t;
  }
  return undefined;
}

/** Microdata-lite: pull itemprop values by name (recipe-specific props only). */
function microdataValues(html: string, prop: string): string[] {
  const out: string[] = [];
  const re = new RegExp(
    `<([a-z0-9]+)[^>]*itemprop=["'][^"']*\\b${prop}\\b[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = stripTags(m[2]);
    if (t) out.push(t);
  }
  return out;
}

function bodyText(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return body
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|br|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?\w+;/g, (e) => ENTITIES[e.toLowerCase()] ?? ENTITIES[e] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Build an ImportedRecipe from a JSON-LD recipe node. */
function fromRecipeNode(node: Record<string, unknown>, sourceUrl: string): ImportedRecipe {
  const ingredientStrings = [
    ...(Array.isArray(node.recipeIngredient) ? node.recipeIngredient : []),
    ...(Array.isArray(node.ingredients) ? node.ingredients : []),
  ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  const y = parseYield(node.recipeYield);
  return {
    title: firstString(node.name),
    description: firstString(node.description),
    ingredients: ingredientStrings.map(parseIngredientLine),
    directions: flattenInstructions(node.recipeInstructions),
    servings: y.servings,
    yieldText: y.yieldText,
    prepMinutes: isoDurationToMinutes(node.prepTime),
    cookMinutes: isoDurationToMinutes(node.cookTime),
    photoUrl: firstImageUrl(node.image),
    sourceUrl,
  };
}

/**
 * Extract a recipe from fetched page content. Pure (no network) so it's
 * unit-testable. Tries JSON-LD, then microdata-lite, then a text heuristic;
 * returns null when nothing recipe-shaped is found.
 */
export function extractRecipe(
  body: string,
  contentType: string,
  sourceUrl: string,
): ImportedRecipe | null {
  // application/ld+json served directly is itself the JSON-LD document.
  const blocks = contentType.includes('application/ld+json')
    ? (() => {
        try {
          return [JSON.parse(body)];
        } catch {
          return [];
        }
      })()
    : jsonLdBlocks(body);

  // The photo candidate is independent of which extraction path wins: JSON-LD
  // node image, else og:image, else twitter:image (og fallback, R3).
  const photoUrl = recipeImageCandidates(body, contentType, sourceUrl)[0];

  const node = recipeFromJsonLd(blocks);
  if (node) {
    const recipe = fromRecipeNode(node, sourceUrl);
    recipe.photoUrl = photoUrl;
    if (recipe.title || recipe.ingredients.length) return recipe;
  }

  // Microdata-lite: recipeIngredient is recipe-specific enough to trust.
  const microIngredients = microdataValues(body, 'recipeIngredient');
  if (microIngredients.length) {
    const microInstr = microdataValues(body, 'recipeInstructions');
    return {
      title: firstString(microdataValues(body, 'name')[0]) ?? htmlTitle(body),
      ingredients: microIngredients.map(parseIngredientLine),
      directions: microInstr.length ? microInstr.join('\n') : undefined,
      photoUrl,
      sourceUrl,
    };
  }

  // Last resort: run the paste heuristic over the visible body text.
  const parsed = parseRecipeText(bodyText(body));
  if (parsed.ingredients.length) {
    return {
      title: htmlTitle(body),
      ingredients: parsed.ingredients,
      directions: parsed.directions,
      photoUrl,
      sourceUrl,
    };
  }

  return null;
}

/** Fetch + extract a recipe from a URL. Never throws — always resolves. */
export async function importRecipeFromUrl(rawUrl: string): Promise<ImportResult> {
  const url = safeImportUrl(rawUrl);
  if (!url) {
    return { status: 'unavailable', reason: 'That URL is not one we can fetch — use an https recipe link.' };
  }
  const fetched = await guardedFetch(url);
  if ('error' in fetched) return { status: 'unavailable', reason: fetched.error };

  let recipe: ImportedRecipe | null;
  try {
    recipe = extractRecipe(fetched.body, fetched.contentType, url.href);
  } catch (err) {
    console.error(`[recipe-import] extraction failure for ${url.href}: ${String(err)}`);
    return { status: 'unavailable', reason: 'Could not read a recipe from that page.' };
  }
  if (!recipe) {
    return { status: 'unavailable', reason: "Couldn't find a recipe on that page — enter it manually." };
  }

  // Best-effort photo: try each candidate as a JPEG, store the first that
  // passes. Never fail the import over a photo — photoUrl still lets the editor
  // note that a source image existed but couldn't be fetched.
  recipe.photoPath = null;
  try {
    const buf = await downloadFirstJpeg(recipeImageCandidates(fetched.body, fetched.contentType, url.href));
    if (buf) recipe.photoPath = await writeImageFile('recipes', buf);
  } catch (err) {
    console.error(`[recipe-import] photo download failed for ${url.href}: ${String(err)}`);
  }

  return { status: 'ok', data: recipe };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/**
 * VLM receipt extraction (blueprint 04 §3). ADVISORY per SPEC §4/§5: every
 * failure degrades to manual entry — this module never throws to the caller,
 * it returns { status: 'unavailable' } with a human-readable reason. Lines
 * are never written to the DB here; the user confirms each one through the
 * normal saveLine flow.
 *
 * Modes (EXTRACTION_MODE, default off):
 * - off      → unavailable immediately; the UI never offers extraction.
 * - fixture  → deterministic: the first receipt image's originalSha256 (the
 *              sha of the ORIGINAL selected file, hashed client-side before
 *              the browser-dependent canvas re-encode) keys a committed JSON
 *              under src/server/extraction-fixtures/. Unknown sha = simulated
 *              failure, exercising the degrade path. No network, no API key.
 * - live     → Anthropic structured outputs over all receipt pages in order.
 */

export const EXTRACTION_MODES = ['off', 'fixture', 'live'] as const;
export type ExtractionMode = (typeof EXTRACTION_MODES)[number];

export function extractionMode(): ExtractionMode {
  const mode = process.env.EXTRACTION_MODE;
  return mode === 'fixture' || mode === 'live' ? mode : 'off';
}

const DEFAULT_MODEL = 'claude-opus-4-8';

function extractionModel() {
  return process.env.EXTRACTION_MODEL || DEFAULT_MODEL;
}

/**
 * Keep the schema simple (structured outputs reject numeric min/max
 * server-side; the SDK strips and validates them client-side, so plain
 * shapes avoid surprises). Money is integer cents (SPEC §6).
 */
const ExtractedLine = z.object({
  description: z.string(), // as printed on the receipt
  unitCount: z.number().int(), // eaches in the pack; 1 if unknown
  lineTotalCents: z.number().int(),
  confidence: z.number().nullable(), // 0..1 model self-estimate; advisory
});
const ReceiptSchema = z.object({
  lines: z.array(ExtractedLine),
  receiptTotalCents: z.number().int().nullable(),
  retailer: z.string().nullable(),
  purchasedAt: z.string().nullable(), // YYYY-MM-DD if legible
});

export type ExtractedReceipt = z.infer<typeof ReceiptSchema>;
export type ExtractionResult =
  | { status: 'ok'; data: ExtractedReceipt; model: string }
  | { status: 'unavailable'; reason: string };

export type ExtractionImage = { jpeg: Buffer; originalSha256: string | null };

const PROMPT =
  'Extract every purchased line item from this retail receipt (multiple images are pages in ' +
  'order). Bulk multipacks: unitCount = the number of eaches in the pack (e.g. "8CT" → 8); 1 ' +
  'when unknown. All money as integer US cents. Discounts and instant savings that apply to an ' +
  'item (e.g. a separate negative line under it) must be NETTED into that item\'s ' +
  'lineTotalCents — report the price actually paid, and never emit a discount as its own line. ' +
  'Skip subtotal, tax, and payment lines; put the printed grand total in receiptTotalCents. ' +
  'Set confidence (0-1) per line for how sure you are of its description and amounts.';

const UNAVAILABLE_MESSAGE = 'Extraction is unavailable right now — enter lines manually.';

async function liveExtract(images: ExtractionImage[]): Promise<ExtractionResult> {
  const model = extractionModel();
  // Reads ANTHROPIC_API_KEY from the environment. SDK retries 429/5xx twice.
  const client = new Anthropic({ maxRetries: 2, timeout: 120_000 });
  const startedAt = Date.now();
  try {
    const res = await client.messages.parse({
      model,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { format: zodOutputFormat(ReceiptSchema) },
      messages: [
        {
          role: 'user',
          content: [
            // Images before the text block; stored receipts are ≤2048px long
            // edge (blueprint 04 §1), inside the model's 2576px vision cap.
            ...images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: 'image/jpeg' as const,
                data: img.jpeg.toString('base64'),
              },
            })),
            { type: 'text' as const, text: PROMPT },
          ],
        },
      ],
    });
    // Cost observability (SPEC: volume is a few receipts a week).
    console.log(
      `[extraction] model=${model} pages=${images.length} ` +
        `input_tokens=${res.usage.input_tokens} output_tokens=${res.usage.output_tokens} ` +
        `stop_reason=${res.stop_reason} ms=${Date.now() - startedAt}`,
    );
    return interpretLiveResponse(
      { stop_reason: res.stop_reason, parsed_output: res.parsed_output },
      model,
    );
  } catch (err) {
    return liveErrorResult(err);
  }
}

/**
 * Pure stop-reason/parse mapping for the live response, split out (with
 * liveErrorResult) so the branches are unit-testable without a network or an
 * API key — see extraction.unit.test.ts.
 */
export function interpretLiveResponse(
  res: { stop_reason: string | null; parsed_output: ExtractedReceipt | null },
  model: string,
): ExtractionResult {
  if (res.stop_reason === 'refusal') {
    return { status: 'unavailable', reason: 'The model declined to read this receipt — enter lines manually.' };
  }
  if (res.stop_reason === 'max_tokens') {
    return { status: 'unavailable', reason: 'The receipt was too long to extract — enter lines manually.' };
  }
  if (!res.parsed_output) {
    return { status: 'unavailable', reason: UNAVAILABLE_MESSAGE };
  }
  return { status: 'ok', data: res.parsed_output, model };
}

/** Typed-error catch chain, most-specific first; every branch degrades to manual entry. */
export function liveErrorResult(err: unknown): ExtractionResult {
  if (err instanceof Anthropic.RateLimitError) {
    console.warn('[extraction] rate limited by the API');
    return { status: 'unavailable', reason: 'Extraction is busy — try again in a minute, or enter lines manually.' };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    console.error('[extraction] ANTHROPIC_API_KEY missing or invalid');
    return { status: 'unavailable', reason: UNAVAILABLE_MESSAGE };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    console.warn(`[extraction] connection error: ${err.message}`);
    return { status: 'unavailable', reason: 'Could not reach the extraction service — try again, or enter lines manually.' };
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`[extraction] API error ${err.status}: ${err.message}`);
    return { status: 'unavailable', reason: UNAVAILABLE_MESSAGE };
  }
  console.error(`[extraction] unexpected failure: ${String(err)}`);
  return { status: 'unavailable', reason: UNAVAILABLE_MESSAGE };
}

/** Committed fixtures live in src/ (not e2e/ — .dockerignore excludes e2e). */
const FIXTURES_DIR = path.join(process.cwd(), 'src/server/extraction-fixtures');

async function fixtureExtract(images: ExtractionImage[]): Promise<ExtractionResult> {
  const sha = images[0]?.originalSha256;
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
    return { status: 'unavailable', reason: UNAVAILABLE_MESSAGE };
  }
  const raw = await fs.readFile(path.join(FIXTURES_DIR, `${sha}.json`), 'utf8').catch(() => null);
  if (raw === null) {
    // Unknown sha: the simulated failure that exercises the degrade path.
    return { status: 'unavailable', reason: UNAVAILABLE_MESSAGE };
  }
  // JSON.parse can throw on a malformed fixture (truncated write, trailing
  // comma); this module's contract is "never throws to the caller", so a bad
  // fixture degrades exactly like a schema mismatch.
  const data = parseStoredExtraction(raw);
  if (!data) {
    console.error(`[extraction] fixture ${sha}.json is not valid ReceiptSchema JSON`);
    return { status: 'unavailable', reason: UNAVAILABLE_MESSAGE };
  }
  return { status: 'ok', data, model: 'fixture' };
}

/**
 * Parse a stored extraction JSON blob (Restock.extractionJson or a fixture
 * file) back into schema shape; null on malformed JSON or schema mismatch.
 */
export function parseStoredExtraction(json: string | null): ExtractedReceipt | null {
  if (!json) return null;
  try {
    const parsed = ReceiptSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Parse Restock.extractionResolved (JSON array of line indices); [] when absent/invalid. */
export function parseResolvedIndices(json: string | null): number[] {
  if (!json) return [];
  try {
    const arr: unknown = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export async function extractReceipt(images: ExtractionImage[]): Promise<ExtractionResult> {
  if (images.length === 0) {
    return { status: 'unavailable', reason: 'No receipt photos to extract from.' };
  }
  switch (extractionMode()) {
    case 'off':
      return { status: 'unavailable', reason: 'Extraction is not configured.' };
    case 'fixture':
      return fixtureExtract(images);
    case 'live':
      return liveExtract(images);
  }
}

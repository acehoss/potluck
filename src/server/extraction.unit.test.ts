/**
 * Unit tests for the extraction module's branch logic that e2e can't reach:
 * the live response/stop_reason mapping and the typed-error catch chain
 * (stubbed — no network, no API key), plus the stored-JSON parsers and the
 * fixture-mode malformed-JSON degrade path.
 *
 * Run: npm run test:unit  (tsx --test; part of the definition of done)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import {
  extractReceipt,
  interpretLiveResponse,
  liveErrorResult,
  parseResolvedIndices,
  parseStoredExtraction,
} from './extraction';

const receipt = {
  lines: [{ description: 'X', unitCount: 1, lineTotalCents: 100, confidence: null }],
  receiptTotalCents: null,
  retailer: null,
  purchasedAt: null,
};

test('interpretLiveResponse: refusal → unavailable with a manual-entry message', () => {
  const r = interpretLiveResponse({ stop_reason: 'refusal', parsed_output: null }, 'm');
  assert.equal(r.status, 'unavailable');
  assert.match((r as { reason: string }).reason, /declined.*enter lines manually/);
});

test('interpretLiveResponse: max_tokens → unavailable', () => {
  const r = interpretLiveResponse({ stop_reason: 'max_tokens', parsed_output: receipt }, 'm');
  assert.equal(r.status, 'unavailable');
  assert.match((r as { reason: string }).reason, /too long/);
});

test('interpretLiveResponse: null parsed_output → unavailable', () => {
  const r = interpretLiveResponse({ stop_reason: 'end_turn', parsed_output: null }, 'm');
  assert.equal(r.status, 'unavailable');
});

test('interpretLiveResponse: parsed output → ok with the model recorded', () => {
  const r = interpretLiveResponse({ stop_reason: 'end_turn', parsed_output: receipt }, 'model-x');
  assert.deepEqual(r, { status: 'ok', data: receipt, model: 'model-x' });
});

const apiError = (status: number, type: string) =>
  Anthropic.APIError.generate(status, { error: { type, message: 'x' } }, 'x', new Headers());

test('liveErrorResult: RateLimitError → retriable "busy" message', () => {
  const err = apiError(429, 'rate_limit_error');
  assert.ok(err instanceof Anthropic.RateLimitError);
  const r = liveErrorResult(err);
  assert.equal(r.status, 'unavailable');
  assert.match((r as { reason: string }).reason, /busy/);
});

test('liveErrorResult: AuthenticationError → generic unavailable (no key details leak)', () => {
  const r = liveErrorResult(apiError(401, 'authentication_error'));
  assert.equal(r.status, 'unavailable');
  assert.match((r as { reason: string }).reason, /^Extraction is unavailable/);
});

test('liveErrorResult: APIConnectionError → "could not reach" message', () => {
  const r = liveErrorResult(new Anthropic.APIConnectionError({ message: 'boom' }));
  assert.equal(r.status, 'unavailable');
  assert.match((r as { reason: string }).reason, /Could not reach/);
});

test('liveErrorResult: other APIError and unknown errors → generic unavailable', () => {
  for (const err of [apiError(500, 'api_error'), new Error('surprise'), 'not even an Error']) {
    const r = liveErrorResult(err);
    assert.equal(r.status, 'unavailable');
    assert.match((r as { reason: string }).reason, /^Extraction is unavailable/);
  }
});

test('parseStoredExtraction: valid, malformed JSON, schema mismatch, null', () => {
  assert.deepEqual(parseStoredExtraction(JSON.stringify(receipt)), receipt);
  assert.equal(parseStoredExtraction('{"lines": [truncated'), null);
  assert.equal(parseStoredExtraction('{"lines": "nope"}'), null);
  assert.equal(parseStoredExtraction(null), null);
});

test('parseResolvedIndices: valid, junk entries filtered, malformed, null', () => {
  assert.deepEqual(parseResolvedIndices('[0,2,5]'), [0, 2, 5]);
  assert.deepEqual(parseResolvedIndices('[0,"x",1.5,3]'), [0, 3]);
  assert.deepEqual(parseResolvedIndices('not json'), []);
  assert.deepEqual(parseResolvedIndices(null), []);
});

test('fixture mode: malformed fixture JSON degrades to unavailable, never throws', async () => {
  const sha = 'ff'.repeat(32);
  const fixturePath = path.join(process.cwd(), 'src/server/extraction-fixtures', `${sha}.json`);
  const prevMode = process.env.EXTRACTION_MODE;
  process.env.EXTRACTION_MODE = 'fixture';
  try {
    await fs.writeFile(fixturePath, '{"lines": [,]}'); // syntax error
    const r = await extractReceipt([{ jpeg: Buffer.from([0xff, 0xd8]), originalSha256: sha }]);
    assert.equal(r.status, 'unavailable');
  } finally {
    process.env.EXTRACTION_MODE = prevMode;
    await fs.unlink(fixturePath).catch(() => {});
  }
});

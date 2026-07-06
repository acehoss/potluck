import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatUsPhone, phoneHref } from './phone';

/**
 * Edge cases beyond phone.unit.test.ts (owned by prof-e2e). Focus: the as-you-type
 * paths a real keypad/paste hits that the progressive-happy-path test doesn't —
 * backspacing through a formatted value, whitespace-wrapped pastes, the country-
 * code boundary (a leading `1` is only a country code at the 11th digit), and the
 * href fallbacks/idempotency the tel:/sms: + vCard consumers rely on.
 */

test('formatUsPhone: backspacing a formatted value reformats down cleanly', () => {
  // Deleting characters off the end of '(913) 555-0142' one edit at a time —
  // each intermediate DOM value re-derives from its digits, never accreting punctuation.
  assert.equal(formatUsPhone('(913) 555-014'), '(913) 555-014');
  assert.equal(formatUsPhone('(913) 555-'), '(913) 555');
  assert.equal(formatUsPhone('(913) 55'), '(913) 55');
  assert.equal(formatUsPhone('(913)'), '(913)');
  assert.equal(formatUsPhone('(91'), '(91');
  assert.equal(formatUsPhone('('), '('); // no digits left → untouched
});

test('formatUsPhone: whitespace-wrapped digits still format', () => {
  assert.equal(formatUsPhone('  9135550142  '), '(913) 555-0142');
  assert.equal(formatUsPhone('\t913 555 0142'), '(913) 555-0142');
});

test('formatUsPhone: a leading 1 is a country code ONLY at 11 digits', () => {
  // Below 11 digits the 1 is just the first national digit (area code).
  assert.equal(formatUsPhone('1'), '(1');
  assert.equal(formatUsPhone('1913'), '(191) 3');
  assert.equal(formatUsPhone('1913555014'), '(191) 355-5014'); // 10 digits, no country code
  // The 11th digit flips it to country-code form.
  assert.equal(formatUsPhone('19135550142'), '1 (913) 555-0142');
});

test('phoneHref: 11-digit non-1 and bare short numbers fall back to digits', () => {
  assert.equal(phoneHref('29135550142'), '29135550142'); // 11 digits, no leading 1, no + → bare
  assert.equal(phoneHref('(555) 010'), '555010'); // 6 digits → bare fallback
});

test('phoneHref is idempotent on its own normalized output', () => {
  const once = phoneHref('9135550142'); // → +19135550142
  assert.equal(once, '+19135550142');
  assert.equal(phoneHref(once), '+19135550142'); // leading + honored, unchanged
});

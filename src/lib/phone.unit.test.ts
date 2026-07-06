import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatUsPhone, phoneDigits, phoneHref } from './phone';

test('formatUsPhone: progressive as-you-type US states', () => {
  assert.equal(formatUsPhone('9'), '(9');
  assert.equal(formatUsPhone('91'), '(91');
  assert.equal(formatUsPhone('913'), '(913)');
  assert.equal(formatUsPhone('9135'), '(913) 5');
  assert.equal(formatUsPhone('913555'), '(913) 555');
  assert.equal(formatUsPhone('9135550'), '(913) 555-0');
  assert.equal(formatUsPhone('9135550142'), '(913) 555-0142');
});

test('formatUsPhone: ignores punctuation the keypad or a paste may include', () => {
  // Re-formatting an already-formatted value is idempotent.
  assert.equal(formatUsPhone('(913) 555-0142'), '(913) 555-0142');
  // Digits interleaved with junk still format.
  assert.equal(formatUsPhone('913.555.0142'), '(913) 555-0142');
});

test('formatUsPhone: 11 digits with leading 1 → country-code form', () => {
  assert.equal(formatUsPhone('19135550142'), '1 (913) 555-0142');
  // A pasted +1 number normalizes the same way (the + is dropped from display).
  assert.equal(formatUsPhone('+1 (913) 555-0142'), '1 (913) 555-0142');
});

test('formatUsPhone: non-US input passes through unchanged', () => {
  assert.equal(formatUsPhone('+44 20 7946 0958'), '+44 20 7946 0958'); // +, not +1
  assert.equal(formatUsPhone('+33123456789'), '+33123456789');
  assert.equal(formatUsPhone('123456789012'), '123456789012'); // 12 digits, too long
  assert.equal(formatUsPhone('29135550142'), '29135550142'); // 11 digits, not leading 1
});

test('formatUsPhone: garbage and empty', () => {
  assert.equal(formatUsPhone(''), '');
  assert.equal(formatUsPhone('   '), '   '); // no digits → untouched
  assert.equal(formatUsPhone('call me!'), 'call me!'); // no digits → untouched
});

test('phoneDigits: digits only, one leading + preserved', () => {
  assert.equal(phoneDigits('(913) 555-0142'), '9135550142');
  assert.equal(phoneDigits('+44 20 7946 0958'), '+442079460958');
  assert.equal(phoneDigits('1 (913) 555-0142'), '19135550142');
  assert.equal(phoneDigits(''), '');
});

test('phoneHref: E.164-ish normalization matrix', () => {
  assert.equal(phoneHref('(913) 555-0142'), '+19135550142'); // 10 digits → +1
  assert.equal(phoneHref('9135550142'), '+19135550142');
  assert.equal(phoneHref('1 (913) 555-0142'), '+19135550142'); // 11 leading 1
  assert.equal(phoneHref('19135550142'), '+19135550142');
  assert.equal(phoneHref('+44 20 7946 0958'), '+442079460958'); // leading + honored
  assert.equal(phoneHref('555-1234'), '5551234'); // 7 digits → bare fallback
  assert.equal(phoneHref(''), '');
});

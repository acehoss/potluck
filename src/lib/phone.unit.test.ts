import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatUsPhone, formatUsPhoneEdit, phoneDigits, phoneHref } from './phone';

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

// ---------------------------------------------------------------------------
// formatUsPhoneEdit — the deletion-aware wrapper the profile input uses (Q1).
// The bug it fixes: a naive reformat re-inserts a formatter-added separator the
// user just backspaced over, trapping the caret so you can't delete into the
// area code. When the value got SHORTER but the digits are identical, only
// punctuation was removed → drop the last DIGIT instead of reformatting in place.

test('formatUsPhoneEdit: backspacing a formatter separator drops a digit (each of ) ( space dash)', () => {
  // `)` removed from '(913)' → same digits, shorter → drop a digit → '(91'.
  assert.equal(formatUsPhoneEdit('(913)', '(913'), '(91');
  // leading `(` removed from '(913' → same digits '913' → drop a digit → '(91'.
  assert.equal(formatUsPhoneEdit('(913', '913'), '(91');
  // the space removed from '(913) 555' → same digits '913555' → '(913) 55'.
  assert.equal(formatUsPhoneEdit('(913) 555', '(913)555'), '(913) 55');
  // the dash removed from '(913) 555-0142' → same digits → '(913) 555-014'.
  assert.equal(formatUsPhoneEdit('(913) 555-0142', '(913) 5550142'), '(913) 555-014');
});

test('formatUsPhoneEdit: deleting an actual digit just reformats (not the punctuation path)', () => {
  // A mid-string digit removed → digits differ → plain formatUsPhone over next.
  assert.equal(formatUsPhoneEdit('(913) 555-0142', '(13) 555-0142'), formatUsPhone('(13) 555-0142'));
  assert.equal(formatUsPhoneEdit('(913) 555-0142', '(13) 555-0142'), '(135) 550-142');
  // An end digit removed (the normal backspace-off-the-end) → reformat down.
  assert.equal(formatUsPhoneEdit('(913) 555-0142', '(913) 555-014'), '(913) 555-014');
});

test('formatUsPhoneEdit: additions and pastes are unchanged formatUsPhone (longer or different digits)', () => {
  // Typing a digit (longer) → format the whole thing.
  assert.equal(formatUsPhoneEdit('(913)', '(913)5'), '(913) 5');
  assert.equal(formatUsPhoneEdit('(913)', '(913)5'), formatUsPhone('(913)5'));
  // A paste that replaces the field (different digits) → format the paste.
  assert.equal(formatUsPhoneEdit('(913) 555-0142', '19998887777'), '1 (999) 888-7777');
  assert.equal(formatUsPhoneEdit('(913) 555-0142', '19998887777'), formatUsPhone('19998887777'));
});

test('formatUsPhoneEdit: backspacing all the way down reaches empty (the reported bug)', () => {
  // Simulate the browser deleting one trailing char per keypress from a saved
  // number, feeding each intermediate value back through the edit wrapper. It
  // must strictly shrink and end at ''.
  let value = '(913) 555-0142';
  const seen = new Set<string>([value]);
  for (let i = 0; i < 40 && value.length > 0; i++) {
    const next = value.slice(0, -1); // browser removes the last character
    value = formatUsPhoneEdit(value, next);
    assert.ok(!seen.has(value), `progress made, not stuck at ${JSON.stringify(value)}`);
    seen.add(value);
  }
  assert.equal(value, '', 'backspace reaches empty');
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

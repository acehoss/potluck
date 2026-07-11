import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVcard, vcardContentDisposition, vcardEscape, vcardNameParts } from './vcard';

test('vcardEscape: comma, semicolon, newline, backslash per RFC 2426', () => {
  assert.equal(vcardEscape('Smith, Jane'), 'Smith\\, Jane');
  assert.equal(vcardEscape('a;b'), 'a\\;b');
  assert.equal(vcardEscape('line1\nline2'), 'line1\\nline2');
  assert.equal(vcardEscape('line1\r\nline2'), 'line1\\nline2');
  // Backslash escaped FIRST — the escapes for the others are not re-escaped.
  assert.equal(vcardEscape('a\\b'), 'a\\\\b');
  assert.equal(vcardEscape('a\\,b'), 'a\\\\\\,b');
  // All four at once.
  assert.equal(vcardEscape('x\\y,z;w\nv'), 'x\\\\y\\,z\\;w\\nv');
});

test('vcardEscape: leaves plain text untouched', () => {
  assert.equal(vcardEscape('Aaron Heise'), 'Aaron Heise');
  assert.equal(vcardEscape(''), '');
});

test('vcardNameParts: maps display names conservatively and extracts quoted nicknames', () => {
  assert.deepEqual(vcardNameParts('Aaron "Hoss" Heise'), {
    family: 'Heise',
    given: 'Aaron',
    additional: '',
    prefix: '',
    suffix: '',
    nickname: 'Hoss',
  });
  assert.deepEqual(vcardNameParts('Dr. Jane Q. Public Jr.'), {
    family: 'Public',
    given: 'Jane',
    additional: 'Q.',
    prefix: 'Dr.',
    suffix: 'Jr.',
    nickname: null,
  });
  assert.deepEqual(vcardNameParts('Dana'), {
    family: '',
    given: 'Dana',
    additional: '',
    prefix: '',
    suffix: '',
    nickname: null,
  });
});

test('buildVcard: full card escapes every field and emits CRLF lines', () => {
  const card = buildVcard({
    name: 'Smith; Jane',
    org: 'Heise · Potluck',
    email: 'jane@example.com',
    phone: '(913) 555-0142',
    address: '12 Main St\nApt 4',
    bio: 'Loves, sourdough; bakes weekly',
  });
  const lines = card.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCARD');
  assert.equal(lines[1], 'VERSION:3.0');
  assert.ok(card.includes('N:Jane;Smith\\;;;;'));
  assert.ok(card.includes('FN:Smith\\; Jane'));
  assert.ok(card.includes('ORG:Heise · Potluck'));
  // TEL is normalized to the E.164-ish phoneHref form, not the stored display string.
  assert.ok(card.includes('TEL;TYPE=CELL:+19135550142'));
  assert.ok(card.includes('EMAIL:jane@example.com'));
  // Free-text address in the 3rd (street) ADR component, newline escaped.
  assert.ok(card.includes('ADR;TYPE=HOME:;;12 Main St\\nApt 4;;;;'));
  assert.ok(card.includes('NOTE:Loves\\, sourdough\\; bakes weekly'));
  assert.equal(card.endsWith('END:VCARD\r\n'), true);
});

test('buildVcard: omits optional lines when absent', () => {
  const card = buildVcard({ name: 'Dana', org: 'In-Laws · Potluck', email: 'dana@demo.coop' });
  assert.ok(!card.includes('TEL'));
  assert.ok(!card.includes('ADR'));
  assert.ok(!card.includes('NOTE'));
  assert.ok(card.includes('N:;Dana;;;'));
  assert.ok(card.includes('FN:Dana'));
  assert.ok(card.includes('EMAIL:dana@demo.coop'));
});

test('buildVcard: emits structured and nickname fields for Apple contact import', () => {
  const card = buildVcard({
    name: 'Aaron "Hoss" Heise',
    org: 'Heise/Marxen · Potluck',
    email: 'aaron@example.com',
  });
  assert.ok(card.includes('N:Heise;Aaron;;;'));
  assert.ok(card.includes('FN:Aaron "Hoss" Heise'));
  assert.ok(card.includes('NICKNAME:Hoss'));
});

test('vcardContentDisposition: quoted ascii filename + RFC 5987 filename*', () => {
  const cd = vcardContentDisposition('Aaron Heise');
  assert.equal(cd, `attachment; filename="Aaron Heise.vcf"; filename*=UTF-8''Aaron%20Heise.vcf`);
  // Header-breaking characters are stripped from the quoted form; unicode kept
  // in filename*.
  const tricky = vcardContentDisposition('Zoë "Z"\n');
  // Quotes/newlines dropped, ë → _ in the ascii fallback; unicode kept in filename*.
  assert.equal(tricky, `attachment; filename="Zo_ Z.vcf"; filename*=UTF-8''Zo%C3%AB%20%22Z%22.vcf`);
});

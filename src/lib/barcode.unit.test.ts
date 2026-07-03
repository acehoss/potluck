import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeUpcQuery, normalizeScannedCode } from './barcode';

test('normalizeScannedCode: EAN-13 with leading zero collapses to UPC-A', () => {
  assert.equal(normalizeScannedCode('0012345678905'), '012345678905');
});

test('normalizeScannedCode: 12-digit UPC-A passes through', () => {
  assert.equal(normalizeScannedCode('012345678905'), '012345678905');
});

test('normalizeScannedCode: true EAN-13 (non-zero lead) stays 13 digits', () => {
  assert.equal(normalizeScannedCode('4006381333931'), '4006381333931');
});

test('normalizeScannedCode: EAN-8 passes through', () => {
  assert.equal(normalizeScannedCode('96385074'), '96385074');
});

test('normalizeScannedCode: trims whitespace', () => {
  assert.equal(normalizeScannedCode(' 012345678905 '), '012345678905');
});

test('normalizeScannedCode: rejects non-digits and wrong lengths', () => {
  assert.equal(normalizeScannedCode('not-a-code'), null);
  assert.equal(normalizeScannedCode('1234567'), null); // too short
  assert.equal(normalizeScannedCode('123456789012345'), null); // too long
  assert.equal(normalizeScannedCode(''), null);
});

test('looksLikeUpcQuery: digits of retail length only', () => {
  assert.equal(looksLikeUpcQuery('012345678905'), true);
  assert.equal(looksLikeUpcQuery('96385074'), true);
  assert.equal(looksLikeUpcQuery('tomatoes'), false);
  assert.equal(looksLikeUpcQuery('1234'), false);
});

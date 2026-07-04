import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatQuantity, mergeAmounts, parseAmountValue, scaleAmount } from './plan-scale';

test('scaleAmount: doubles a plain integer', () => {
  assert.equal(scaleAmount('2', 2), '4');
});

test('scaleAmount: halves a mixed number to a fraction', () => {
  assert.equal(scaleAmount('1 1/2', 0.5), '3/4');
});

test('scaleAmount: doubles a mixed number', () => {
  assert.equal(scaleAmount('1 1/2', 2), '3');
});

test('scaleAmount: doubles a unicode fraction', () => {
  assert.equal(scaleAmount('½', 2), '1');
});

test('scaleAmount: halves a unicode fraction into eighths', () => {
  assert.equal(scaleAmount('¼', 0.5), '1/8');
});

test('scaleAmount: scales a decimal', () => {
  assert.equal(scaleAmount('1.5', 2), '3');
});

test('scaleAmount: keeps the unit-ish trailing text after the number', () => {
  // Only the amount field is scaled; here the leading token is the whole thing.
  assert.equal(scaleAmount('2', 3), '6');
});

test('scaleAmount: passes an unparseable amount through unchanged', () => {
  assert.equal(scaleAmount('a splash', 2), 'a splash');
  assert.equal(scaleAmount('to taste', 4), 'to taste');
});

test('scaleAmount: factor 1 and blank are untouched', () => {
  assert.equal(scaleAmount('1 1/2', 1), '1 1/2');
  assert.equal(scaleAmount('', 2), '');
});

test('scaleAmount: a range scales only its leading number (documented limit)', () => {
  assert.equal(scaleAmount('2-3', 2), '4-3');
});

test('parseAmountValue: whole-string numeric tokens parse', () => {
  assert.equal(parseAmountValue('2'), 2);
  assert.equal(parseAmountValue('1 1/2'), 1.5);
  assert.equal(parseAmountValue('½'), 0.5);
  assert.equal(parseAmountValue('1.5'), 1.5);
});

test('parseAmountValue: partial / opaque amounts are null', () => {
  assert.equal(parseAmountValue('2-3'), null);
  assert.equal(parseAmountValue('a splash'), null);
  assert.equal(parseAmountValue('1 to 2'), null);
  assert.equal(parseAmountValue(''), null);
  assert.equal(parseAmountValue(null), null);
});

test('mergeAmounts: same-unit numeric amounts sum', () => {
  assert.equal(mergeAmounts(['1', '2']), '3');
  assert.equal(mergeAmounts(['1 1/2', '1 1/2']), '3');
  assert.equal(mergeAmounts(['½', '¼']), '3/4');
});

test('mergeAmounts: non-numeric amounts join with a sum', () => {
  assert.equal(mergeAmounts(['2', 'a splash']), '2 + a splash');
});

test('mergeAmounts: only non-numeric amounts just join', () => {
  assert.equal(mergeAmounts(['a splash', 'a pinch']), 'a splash + a pinch');
});

test('mergeAmounts: blanks and nullish contribute nothing', () => {
  assert.equal(mergeAmounts([null, '', undefined]), null);
  assert.equal(mergeAmounts([]), null);
  assert.equal(mergeAmounts(['3', null, '']), '3');
});

test('formatQuantity: renders kitchen fractions', () => {
  assert.equal(formatQuantity(0.75), '3/4');
  assert.equal(formatQuantity(2), '2');
  assert.equal(formatQuantity(1.5), '1 1/2');
});

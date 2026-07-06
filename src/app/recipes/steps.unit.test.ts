import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitSteps } from './steps';

/**
 * The shared directions→steps splitter (Round R). The read view's numbered list
 * and the Cook view's stepper both call it, so its edge behavior is load-bearing:
 * split on newlines, trim, drop empties, and strip a leading "1." / "1)" number
 * so a hand-numbered paste doesn't double up with the UI's own numbering.
 */

test('splits on newlines and trims each step', () => {
  assert.deepEqual(splitSteps('Warm the pan.\nStir the flour.\nBake it.'), [
    'Warm the pan.',
    'Stir the flour.',
    'Bake it.',
  ]);
  assert.deepEqual(splitSteps('  Padded step  \n\tTabbed step\t'), ['Padded step', 'Tabbed step']);
});

test('blank lines and whitespace-only lines fall out as empties', () => {
  assert.deepEqual(splitSteps('A\n\n\nB\n   \nC'), ['A', 'B', 'C']);
  assert.deepEqual(splitSteps('First\r\n\r\nSecond'), ['First', 'Second']); // CRLF too
});

test('strips a leading "1." / "1)" style number (any width)', () => {
  assert.deepEqual(splitSteps('1. First\n2. Second\n3. Third'), ['First', 'Second', 'Third']);
  assert.deepEqual(splitSteps('1) First\n2) Second'), ['First', 'Second']);
  assert.deepEqual(splitSteps('10. Tenth'), ['Tenth']);
});

test('only the LEADING number is stripped — interior digits survive', () => {
  assert.deepEqual(splitSteps('Mix 2 cups of flour with 1 egg.'), ['Mix 2 cups of flour with 1 egg.']);
  assert.deepEqual(splitSteps('Bake at 350 for 20 min.'), ['Bake at 350 for 20 min.']);
});

test('a line that is only a number becomes empty and is dropped', () => {
  assert.deepEqual(splitSteps('1. Real step\n2.'), ['Real step']);
});

test('nullish or blank input yields an empty list', () => {
  assert.deepEqual(splitSteps(null), []);
  assert.deepEqual(splitSteps(undefined), []);
  assert.deepEqual(splitSteps(''), []);
  assert.deepEqual(splitSteps('   \n  \n\t'), []);
});

test('a single step returns one element', () => {
  assert.deepEqual(splitSteps('Just the one instruction here'), ['Just the one instruction here']);
});

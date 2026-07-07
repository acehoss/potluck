import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveMediaToMain } from './media-positions';

test('moveMediaToMain moves target to zero and shifts earlier positions', () => {
  assert.deepEqual(
    moveMediaToMain(
      [
        { id: 'a', position: 0 },
        { id: 'b', position: 1 },
        { id: 'c', position: 2 },
      ],
      'c',
    ),
    [
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
      { id: 'c', position: 0 },
    ],
  );
});

test('moveMediaToMain preserves sparse positions after the target', () => {
  assert.deepEqual(
    moveMediaToMain(
      [
        { id: 'a', position: 0 },
        { id: 'b', position: 4 },
        { id: 'c', position: 9 },
      ],
      'b',
    ),
    [
      { id: 'a', position: 1 },
      { id: 'b', position: 0 },
      { id: 'c', position: 9 },
    ],
  );
});

test('moveMediaToMain throws when the target is absent', () => {
  assert.throws(() => moveMediaToMain([{ id: 'a', position: 0 }], 'nope'), /not found/);
});

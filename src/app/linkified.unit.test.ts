import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkifySegments } from './linkified';

/** Reconstructing the segments must always yield the original text. */
function roundtrip(text: string) {
  return linkifySegments(text)
    .map((s) => s.value)
    .join('');
}
function links(text: string) {
  return linkifySegments(text)
    .filter((s) => s.type === 'link')
    .map((s) => s.value);
}

test('plain text with no url is a single text segment', () => {
  const segs = linkifySegments('just some notes here');
  assert.deepEqual(segs, [{ type: 'text', value: 'just some notes here' }]);
});

test('a bare url becomes a single link segment', () => {
  const segs = linkifySegments('https://example.com/manual');
  assert.deepEqual(segs, [{ type: 'link', value: 'https://example.com/manual' }]);
});

test('url embedded in prose splits into text/link/text', () => {
  const segs = linkifySegments('see https://example.com now');
  assert.deepEqual(segs, [
    { type: 'text', value: 'see ' },
    { type: 'link', value: 'https://example.com' },
    { type: 'text', value: ' now' },
  ]);
});

test('trailing sentence punctuation is not swallowed', () => {
  assert.deepEqual(links('read https://example.com/guide.'), ['https://example.com/guide']);
  assert.deepEqual(links('(https://example.com)'), ['https://example.com']);
  assert.deepEqual(links('here: https://example.com/a?b=1!'), ['https://example.com/a?b=1']);
  assert.equal(roundtrip('read https://example.com/guide.'), 'read https://example.com/guide.');
  assert.equal(roundtrip('(https://example.com)'), '(https://example.com)');
});

test('http and https both match; other schemes stay text', () => {
  assert.deepEqual(links('http://a.test and https://b.test'), ['http://a.test', 'https://b.test']);
  assert.deepEqual(links('ftp://a.test or mailto:x@y.test or javascript:alert(1)'), []);
});

test('multiple urls with text between them', () => {
  const text = 'one https://a.test two https://b.test three';
  assert.deepEqual(links(text), ['https://a.test', 'https://b.test']);
  assert.equal(roundtrip(text), text);
});

test('roundtrip preserves newlines and spacing', () => {
  const text = 'line one\nhttps://a.test\n\nline three';
  assert.equal(roundtrip(text), text);
  assert.deepEqual(links(text), ['https://a.test']);
});

test('a bare scheme with no host degrades to text', () => {
  assert.deepEqual(links('https:// nothing'), []);
});

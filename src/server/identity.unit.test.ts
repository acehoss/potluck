import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  USERNAME_PATTERN,
  firstAvailableHandle,
  slugBaseFromName,
  usernameBaseFromEmail,
} from './identity';

test('usernameBaseFromEmail: plain local part passes through', () => {
  assert.equal(usernameBaseFromEmail('aaron@demo.coop'), 'aaron');
});

test('usernameBaseFromEmail: dots and pluses become dashes, case lowers', () => {
  assert.equal(usernameBaseFromEmail('Aaron.B+tag@example.com'), 'aaron-b-tag');
});

test('usernameBaseFromEmail: out-of-charset chars collapse to single dashes', () => {
  assert.equal(usernameBaseFromEmail('we%ird=local@x.com'), 'we-ird-local');
});

test('usernameBaseFromEmail: leading/trailing separators are trimmed', () => {
  assert.equal(usernameBaseFromEmail('.aaron.@x.com'), 'aaron');
});

test('usernameBaseFromEmail: short local parts get the fallback pad', () => {
  assert.equal(usernameBaseFromEmail('ab@x.com'), 'ab-user');
  assert.equal(usernameBaseFromEmail('a@x.com'), 'a-user');
});

test('usernameBaseFromEmail: empty/unusable local part falls back entirely', () => {
  assert.equal(usernameBaseFromEmail('...@x.com'), 'user');
});

test('usernameBaseFromEmail: long local parts are capped at 24', () => {
  const base = usernameBaseFromEmail(`${'a'.repeat(40)}@x.com`);
  assert.equal(base.length, 24);
});

test('usernameBaseFromEmail: always yields a valid username', () => {
  for (const email of [
    'aaron@demo.coop',
    'A.B+c@x.com',
    'ab@x.com',
    '...@x.com',
    'we%ird=local@x.com',
    `${'x'.repeat(64)}@x.com`,
    'ñoño@x.com',
  ]) {
    const base = usernameBaseFromEmail(email);
    assert.match(base, USERNAME_PATTERN, `"${base}" from ${email}`);
  }
});

test('slugBaseFromName: household names slugify', () => {
  assert.equal(slugBaseFromName('In-Laws'), 'in-laws');
  assert.equal(slugBaseFromName('Heise'), 'heise');
  assert.equal(slugBaseFromName('Smith & Jones'), 'smith-jones');
});

test('slugBaseFromName: punctuation-only names fall back', () => {
  assert.equal(slugBaseFromName('...'), 'household');
});

test('firstAvailableHandle: returns the base when free', async () => {
  assert.equal(await firstAvailableHandle('aaron', async () => false), 'aaron');
});

test('firstAvailableHandle: bumps to the first free numbered suffix', async () => {
  const taken = new Set(['aaron', 'aaron-2', 'aaron-3']);
  assert.equal(
    await firstAvailableHandle('aaron', async (c) => taken.has(c)),
    'aaron-4',
  );
});

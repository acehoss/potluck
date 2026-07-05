/**
 * Fail-closed proof for the dev mail filter (contract A1.3 / A2.1). This is the
 * security-critical unit: it decides who actually receives mail on a non-prod
 * stack, and every ambiguous branch must fail TOWARD not-delivering. e2e can't
 * exercise the redirect/regex branches (the fixture stack has one env), so the
 * matrix lives here.
 *
 * Run: npm run test:unit  (tsx --test)
 *
 * INTEGRATION NOTE: builds against the contract's `resolveRecipients` signature
 * (see round-a-contract.md A1.3). Confirmed shape with mail-server:
 *   resolveRecipients({ to, subject, allowlist, redirect, subjectPrefix, production })
 *     → { deliverTo: string[], captureOnly: boolean, subject, xOriginalTo }
 * If the landed signature differs, only the `call()` helper below needs editing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRecipients } from './dev-filter';

const PREFIX = '[Potluck Dev] ';

/** Defaults keep each test to the one dimension it exercises. */
function call(over: {
  to?: string;
  subject?: string;
  allowlist?: string[];
  redirect?: string[];
  subjectPrefix?: string;
  production?: boolean;
}) {
  return resolveRecipients({
    to: 'stranger@example.com',
    subject: 'Verify your email',
    allowlist: [],
    redirect: [],
    subjectPrefix: '',
    production: false,
    ...over,
  });
}

test('production: delivers to the real recipient as-is, no prefix, no redirect', () => {
  const r = call({
    to: 'real.user@gmail.com',
    subject: 'Verify your email',
    subjectPrefix: PREFIX, // present but MUST be ignored in production
    redirect: ['sink@dev.test'],
    allowlist: [],
    production: true,
  });
  assert.deepEqual(r.deliverTo, ['real.user@gmail.com']);
  assert.equal(r.captureOnly, false);
  assert.equal(r.xOriginalTo, null);
  assert.equal(r.subject, 'Verify your email'); // no prefix leaked to real users
});

test('dev + allowlist match: delivered as-is (prefix applied, no redirect)', () => {
  const r = call({
    to: 'dev@team.dev',
    allowlist: ['@team\\.dev$'],
    redirect: ['sink@dev.test'], // present, but an allowlisted addr bypasses it
    subjectPrefix: PREFIX,
  });
  assert.deepEqual(r.deliverTo, ['dev@team.dev']);
  assert.equal(r.captureOnly, false);
  assert.equal(r.xOriginalTo, null);
  assert.ok(r.subject.startsWith(PREFIX), 'dev subject carries the prefix');
});

test('dev + non-allowlisted + redirect set: redirected, original preserved in xOriginalTo', () => {
  const r = call({
    to: 'stranger@example.com',
    allowlist: ['@team\\.dev$'],
    redirect: ['sink1@dev.test', 'sink2@dev.test'],
    subjectPrefix: PREFIX,
  });
  assert.deepEqual(r.deliverTo, ['sink1@dev.test', 'sink2@dev.test']);
  assert.equal(r.captureOnly, false);
  assert.equal(r.xOriginalTo, 'stranger@example.com');
  assert.ok(r.subject.startsWith(PREFIX));
});

test('dev + non-allowlisted + EMPTY redirect: captureOnly (never sends to a stranger)', () => {
  const r = call({
    to: 'stranger@example.com',
    allowlist: ['@team\\.dev$'],
    redirect: [],
    subjectPrefix: PREFIX,
  });
  assert.equal(r.captureOnly, true);
  assert.deepEqual(r.deliverTo, []);
});

test('dev + EMPTY allowlist + EMPTY redirect: everything captureOnly (nobody gets real mail)', () => {
  const r = call({
    to: 'anyone@anywhere.com',
    allowlist: [],
    redirect: [],
    subjectPrefix: PREFIX,
  });
  assert.equal(r.captureOnly, true);
  assert.deepEqual(r.deliverTo, []);
});

test('fail-closed: a malformed allowlist regex is treated as non-matching and never throws', () => {
  // An unterminated group would throw if compiled naively. The recipient it
  // would (accidentally) have matched must NOT be delivered as-is; with no
  // redirect that means captureOnly.
  assert.doesNotThrow(() => {
    const r = call({
      to: 'stranger@example.com',
      allowlist: ['(unclosed', '[a-z', '*bad'],
      redirect: [],
      subjectPrefix: PREFIX,
    });
    assert.equal(r.captureOnly, true, 'bad regex must fail toward capture, not delivery');
    assert.deepEqual(r.deliverTo, []);
  });
});

test('fail-closed: a bad regex before a GOOD matching one still lets the good one match', () => {
  // One broken entry must not disable the whole allowlist.
  const r = call({
    to: 'dev@team.dev',
    allowlist: ['(unclosed', '@team\\.dev$'],
    redirect: ['sink@dev.test'],
    subjectPrefix: PREFIX,
  });
  assert.deepEqual(r.deliverTo, ['dev@team.dev']);
  assert.equal(r.captureOnly, false);
});

test('subject prefix is a dev-only marker: absent in production, present in dev', () => {
  const prod = call({ subject: 'Reset your password', subjectPrefix: PREFIX, production: true });
  assert.equal(prod.subject, 'Reset your password');

  const dev = call({
    subject: 'Reset your password',
    subjectPrefix: PREFIX,
    allowlist: ['.*'], // deliver path so we isolate the prefix behavior
  });
  assert.ok(dev.subject.startsWith(PREFIX));
  assert.ok(dev.subject.includes('Reset your password'));
});

test('empty subjectPrefix in dev leaves the subject unprefixed but still filters recipients', () => {
  const r = call({
    to: 'stranger@example.com',
    subject: 'Hello',
    subjectPrefix: '',
    allowlist: [],
    redirect: [],
  });
  assert.equal(r.subject, 'Hello');
  assert.equal(r.captureOnly, true); // filtering is independent of the prefix
});

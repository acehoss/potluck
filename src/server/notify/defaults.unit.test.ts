/**
 * Category-default resolution (Phase 3 Round C, N5 / C3). An ABSENT
 * NotificationPreference row means the category's default channel matrix:
 *   pickups → push+email ON;  circle → OFF/OFF;  ledger → OFF/OFF.
 * A present row (always carries BOTH channels — the model has non-null push +
 * email columns) overrides the default outright. This is the pure spine the
 * notify fan-out (push.ts) and the mail subscription gate (mail/index.ts) share,
 * so it gets a db-free unit; e2e proves the wired lookup, this proves the table
 * + the row-vs-default choice.
 *
 * Run: npm run test:unit  (tsx --test)
 *
 * INTEGRATION NOTE (awaits notify-server C1.2): imports the PURE, db-free leaf
 * `src/server/notify/defaults.ts` — the pure half of `src/server/notifications.ts`
 * (which can't be imported here: it pulls `./db`, and db.ts constructs the Prisma
 * client at import). notifications.ts re-exports these. Names pinned by message;
 * if any differ, only the import line changes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATEGORY_DEFAULTS,
  NOTIFY_CATEGORIES,
  isNotifyCategory,
  resolveChannelPrefs,
} from './defaults';

test('the default table is the N5 matrix: pickups on/on, circle + ledger off/off', () => {
  assert.deepEqual(CATEGORY_DEFAULTS.pickups, { push: true, email: true });
  assert.deepEqual(CATEGORY_DEFAULTS.circle, { push: false, email: false });
  assert.deepEqual(CATEGORY_DEFAULTS.ledger, { push: false, email: false });
});

test('NOTIFY_CATEGORIES is exactly the three stored, opt-out categories', () => {
  assert.deepEqual([...NOTIFY_CATEGORIES].sort(), ['circle', 'ledger', 'pickups']);
});

test('isNotifyCategory accepts the three stored categories and rejects everything else', () => {
  for (const c of NOTIFY_CATEGORIES) assert.equal(isNotifyCategory(c), true);
  // `account` (transactional) and `digest` are NOT stored opt-out categories.
  for (const c of ['account', 'digest', 'pickup', '', 'PICKUPS']) {
    assert.equal(isNotifyCategory(c), false, `not a stored category: ${JSON.stringify(c)}`);
  }
});

test('resolveChannelPrefs: an absent row resolves to the category default', () => {
  assert.deepEqual(resolveChannelPrefs('pickups', null), { push: true, email: true });
  assert.deepEqual(resolveChannelPrefs('circle', null), { push: false, email: false });
  assert.deepEqual(resolveChannelPrefs('ledger', null), { push: false, email: false });
});

test('resolveChannelPrefs: a present row overrides the default outright', () => {
  // pickups default on/on → a stored off/off wins (the user opted out).
  assert.deepEqual(resolveChannelPrefs('pickups', { push: false, email: false }), {
    push: false,
    email: false,
  });
  // circle default off/off → a stored on/on wins (the user opted in).
  assert.deepEqual(resolveChannelPrefs('circle', { push: true, email: true }), {
    push: true,
    email: true,
  });
});

test('resolveChannelPrefs does not alias the shared default table', () => {
  // Guard against returning the module-level constant by reference (a caller
  // mutating the result must not poison the next lookup).
  const a = resolveChannelPrefs('pickups', null);
  a.push = false;
  assert.deepEqual(resolveChannelPrefs('pickups', null), { push: true, email: true });
});

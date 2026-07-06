import assert from 'node:assert/strict';
import { before, test } from 'node:test';

/**
 * The per-user "is a digest owed right now?" matrix (digest-cadence round). This
 * is the load-bearing gate `runDigest` applies to every user each tick: cadence
 * (off/daily/weekly), the local send-hour match, the weekly weekday match, and
 * the window-idempotency (never twice in the same day / chosen-weekday week).
 *
 * `digestDue` is the pure fn dc-server factors out of `runDigest` so the whole
 * matrix is exercised WITHOUT a DB or the compose stack — the e2e
 * (e2e/digest-cadence.spec.ts) proves the same gate end-to-end through the real
 * batch, but the boundary cases (tz offsets, window edges) live here.
 *
 * Run: npm run test:unit  (tsx --test)
 *
 * INTEGRATION NOTE (awaits dc-server Task-1): imports `digestDue` from
 * `./digest`. digest.ts constructs a Prisma client at import (via db.ts), so we
 * point DATABASE_URL at a throwaway file and dynamic-import in a `before` hook
 * (circles-reach.unit.test.ts's pattern) — the fn under test is pure and never
 * touches the client. If dc-server names the export or its field shape
 * differently, only the import + the `mk` builder below change.
 */

// digest.ts → db.ts constructs a client at import and needs DATABASE_URL; the fn
// under test is pure, so a throwaway path is never actually queried.
process.env.DATABASE_URL ||= 'file:/tmp/digest-due-test.db';
let digestDue: typeof import('./digest').digestDue;

before(async () => {
  ({ digestDue } = await import('./digest'));
});

type DueUser = {
  timezone: string | null;
  digestCadence: string;
  digestHour: number;
  digestWeekday: number;
  lastDigestAt: Date | null;
};

/** A user on their defaults (weekly, 9am, Sunday, UTC), overridden per case. */
function mk(over: Partial<DueUser> = {}): DueUser {
  return {
    timezone: 'UTC',
    digestCadence: 'weekly',
    digestHour: 9,
    digestWeekday: 0,
    lastDigestAt: null,
    ...over,
  };
}

// A fixed reference instant: 2026-07-08T05:00:00Z. Its UTC weekday is derived
// (not hardcoded) so the weekly cases stay correct regardless of the date.
const NOW = new Date('2026-07-08T05:00:00Z');
const NOW_WD = NOW.getUTCDay();
const WRONG_WD = (NOW_WD + 1) % 7;

// ---- off ---------------------------------------------------------------------

test('off cadence is never due, even at a matching hour', () => {
  assert.equal(digestDue(mk({ digestCadence: 'off', digestHour: 5 }), NOW), false);
});

// ---- daily -------------------------------------------------------------------

test('daily: due at the send-hour with no prior send', () => {
  assert.equal(digestDue(mk({ digestCadence: 'daily', digestHour: 5 }), NOW), true);
});

test('daily: not due at any other hour', () => {
  assert.equal(digestDue(mk({ digestCadence: 'daily', digestHour: 6 }), NOW), false);
  assert.equal(digestDue(mk({ digestCadence: 'daily', digestHour: 4 }), NOW), false);
});

test('daily: weekday is irrelevant — due on any day at the hour', () => {
  // digestWeekday set to a non-matching day must NOT suppress a daily send.
  assert.equal(
    digestDue(mk({ digestCadence: 'daily', digestHour: 5, digestWeekday: WRONG_WD }), NOW),
    true,
  );
});

test('daily: already sent earlier today is not due again', () => {
  const sentToday = new Date('2026-07-08T04:00:00Z'); // same UTC day, before now
  assert.equal(
    digestDue(mk({ digestCadence: 'daily', digestHour: 5, lastDigestAt: sentToday }), NOW),
    false,
  );
});

test('daily: sent yesterday is due again today', () => {
  const sentYesterday = new Date('2026-07-07T05:00:00Z');
  assert.equal(
    digestDue(mk({ digestCadence: 'daily', digestHour: 5, lastDigestAt: sentYesterday }), NOW),
    true,
  );
});

// ---- weekly ------------------------------------------------------------------

test('weekly: due on the chosen weekday at the hour with no prior send', () => {
  assert.equal(
    digestDue(mk({ digestCadence: 'weekly', digestHour: 5, digestWeekday: NOW_WD }), NOW),
    true,
  );
});

test('weekly: not due on the wrong weekday even at the right hour', () => {
  assert.equal(
    digestDue(mk({ digestCadence: 'weekly', digestHour: 5, digestWeekday: WRONG_WD }), NOW),
    false,
  );
});

test('weekly: not due at the wrong hour even on the right weekday', () => {
  assert.equal(
    digestDue(mk({ digestCadence: 'weekly', digestHour: 6, digestWeekday: NOW_WD }), NOW),
    false,
  );
});

test('weekly: already sent this window (this weekday-week) is not due again', () => {
  const sentThisWindow = new Date('2026-07-08T01:00:00Z'); // same day, before now
  assert.equal(
    digestDue(
      mk({ digestCadence: 'weekly', digestHour: 5, digestWeekday: NOW_WD, lastDigestAt: sentThisWindow }),
      NOW,
    ),
    false,
  );
});

test('weekly: sent last week is due again this week', () => {
  const sentLastWeek = new Date('2026-07-01T05:00:00Z'); // 7 days earlier
  assert.equal(
    digestDue(
      mk({ digestCadence: 'weekly', digestHour: 5, digestWeekday: NOW_WD, lastDigestAt: sentLastWeek }),
      NOW,
    ),
    true,
  );
});

// ---- timezone: the hour match is LOCAL, not UTC ------------------------------

test('daily: send-hour is evaluated in the user LOCAL zone, not UTC', () => {
  // 2026-07-08T13:00:00Z is 09:00 in America/New_York (EDT, UTC-4 in July).
  const at13Z = new Date('2026-07-08T13:00:00Z');
  const nyUser = mk({ timezone: 'America/New_York', digestCadence: 'daily', digestHour: 9 });
  assert.equal(digestDue(nyUser, at13Z), true); // 09:00 local → due
  // One hour earlier is 08:00 local → not the send-hour.
  const at12Z = new Date('2026-07-08T12:00:00Z');
  assert.equal(digestDue(nyUser, at12Z), false);
  // A UTC user with the same 9am pref is NOT due at 13:00Z (it's 13:00 for them).
  assert.equal(digestDue(mk({ digestCadence: 'daily', digestHour: 9 }), at13Z), false);
});

test('null timezone falls back to UTC for the hour match', () => {
  assert.equal(digestDue(mk({ timezone: null, digestCadence: 'daily', digestHour: 5 }), NOW), true);
  assert.equal(digestDue(mk({ timezone: null, digestCadence: 'daily', digestHour: 6 }), NOW), false);
});

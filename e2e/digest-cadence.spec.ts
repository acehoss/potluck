import { execFileSync } from 'node:child_process';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test';
import { apiLogin } from './helpers';

/**
 * Digest-cadence acceptance (post-Phase-3 round): the per-user cadence gate
 * (off / daily / weekly), the LOCAL send-hour + weekly weekday match, and the
 * window-idempotency, driven end-to-end through the real `runDigest` batch in
 * MAIL_MODE=capture. The pure boundary matrix (tz offsets, window edges) is the
 * unit sibling (src/server/digest-due.unit.test.ts) — this proves the same gate
 * fires the actual subscription pipeline and lands a `digest` CapturedEmail row.
 *
 * The in-process setInterval scheduler itself is NOT exercised here (per the
 * round contract) — we inject the clock and run the batch on demand.
 *
 * Subject: `nia` (Neighbors household, the sole member — a low-traffic mailbox
 * no other spec drives). Isolation: nia is set to a send-hour of 5 (never the
 * seeded default 9), so a whole-instance batch at 05:00Z matches ONLY nia and no
 * seeded daily-default user (they fire only at their hour, 9). workers:1 keeps it
 * serial; every test resets nia's digest columns + sweeps its CapturedEmail rows
 * in `finally`, restoring the byte-identical seeded topology.
 *
 * INTEGRATION NOTE (awaits dc-server Task-1): couples to three still-landing
 * surfaces, centralized below so a gate delta is a one-line edit —
 *   - the `User` columns `digestCadence`/`digestHour`/`digestWeekday` (the DB
 *     seam helpers write/read them; replace `digestOptOut`);
 *   - the `notification` router shape (`get` returns cadence/hour/weekday,
 *     `setPrefs` accepts them) — the NAMES map;
 *   - the `/api/dev/digest-run` clock-injectable + `batch` extension — the DEV
 *     map (ASK 2 to dc-server). If the daily/weekly body wording differs from
 *     the /today/ vs /this week/ assumed here, only the two `toMatch` lines move.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

const EMAIL = { nia: 'nia@demo.coop' } as const;
const USER = 'nia';

const NAMES = {
  prefsGet: 'notification.get', // query → { …, digestCadence, digestHour, digestWeekday }
  setPrefs: 'notification.setPrefs', // { digestCadence?, digestHour?, digestWeekday?, … }
} as const;
const DEV = {
  digestRun: '/api/dev/digest-run', // POST { now?: ISO, batch?: boolean, identifier?, force? }
  unsub: '/unsub', // POST ?token=… body List-Unsubscribe=One-Click (RFC-8058)
} as const;

// A non-Sunday reference day at hour 5 (isolates nia from seeded weekly defaults).
const HOUR = 5;
const AT_HOUR = '2026-07-08T05:00:00Z'; // the send-hour
const OFF_HOUR = '2026-07-08T06:00:00Z'; // one hour later — not the send-hour
const NEXT_DAY_AT_HOUR = '2026-07-09T05:00:00Z'; // a fresh daily window
const RIGHT_WD = new Date(AT_HOUR).getUTCDay();

type Api = Pick<APIRequestContext, 'get' | 'post'>;

// ---- DB seam (notifications.spec bound-`?` read pattern) ---------------------

function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}
const DB_PREAMBLE =
  "const Database=require('better-sqlite3');const db=new Database(process.env.DATABASE_URL.replace(/^file:/,''));";

type CapturedRow = {
  id: string;
  pipeline: string;
  kind: string;
  originalTo: string;
  subject: string;
  textBody: string;
  headersJson: string;
};
const CAP_COLS = 'id, pipeline, kind, originalTo, subject, textBody, headersJson';

/** Highest CapturedEmail rowid now — the finally deletes everything above it. */
function maxCapturedRowid(): number {
  const out = execInApp(
    `${DB_PREAMBLE}process.stdout.write(String(db.prepare('SELECT COALESCE(MAX(rowid),0) m FROM CapturedEmail').get().m));`,
  );
  return Number(out.trim() || '0');
}
/** CapturedEmail rows written after `startRowid` for one intended recipient. */
function capturedSince(startRowid: number, originalTo: string): CapturedRow[] {
  const out = execInApp(
    `${DB_PREAMBLE}const rows=db.prepare('SELECT ${CAP_COLS} FROM CapturedEmail WHERE rowid > ${startRowid} AND originalTo = ? ORDER BY rowid ASC').all(${JSON.stringify(originalTo)});process.stdout.write(JSON.stringify(rows));`,
  );
  return JSON.parse(out.trim() || '[]');
}
/** The `digest`-kind rows this test produced for a recipient. */
function digestRowsFor(startRowid: number, originalTo: string): CapturedRow[] {
  return capturedSince(startRowid, originalTo).filter((r) => r.kind === 'digest');
}
/** Drop every CapturedEmail row this test created (workers:1 → nothing else wrote any). */
function sweepCapturedAbove(startRowid: number) {
  execInApp(`${DB_PREAMBLE}db.prepare('DELETE FROM CapturedEmail WHERE rowid > ${startRowid}').run();`);
}

/** Set a user's digest columns + clear the idempotency watermark. */
function setDigestPrefs(
  username: string,
  p: { cadence: string; hour: number; weekday: number; tz: string | null },
) {
  const args = JSON.stringify([p.cadence, p.hour, p.weekday, p.tz, username]);
  execInApp(
    `${DB_PREAMBLE}db.prepare('UPDATE User SET digestCadence=?, digestHour=?, digestWeekday=?, timezone=?, lastDigestAt=NULL WHERE username=?').run(...${args});`,
  );
}
/** Restore a user's digest state to the seeded default (daily / 9 / Sunday / UTC). */
function resetDigest(username: string) {
  execInApp(
    `${DB_PREAMBLE}db.prepare("UPDATE User SET digestCadence='daily', digestHour=9, digestWeekday=0, timezone=NULL, lastDigestAt=NULL WHERE username=?").run(${JSON.stringify(username)});`,
  );
}
/** Read back a user's current cadence. */
function readCadence(username: string): string {
  return execInApp(
    `${DB_PREAMBLE}const r=db.prepare('SELECT digestCadence c FROM User WHERE username=?').get(${JSON.stringify(username)});process.stdout.write(r?r.c:'');`,
  ).trim();
}

/** Pull the /unsub token out of a captured email's List-Unsubscribe header. */
function unsubTokenFromHeaders(headersJson: string): string {
  const h = JSON.parse(headersJson || '{}') as Record<string, string>;
  const lu = Object.entries(h).find(([k]) => k.toLowerCase() === 'list-unsubscribe')?.[1] ?? '';
  const m = lu.match(/[?&]token=([^>&\s]+)/);
  expect(m, `List-Unsubscribe carries a ?token= URI (got ${JSON.stringify(lu)})`).toBeTruthy();
  return decodeURIComponent(m![1]);
}

// ---- tRPC + batch helpers ----------------------------------------------------

async function rpc(api: Api, path: string, data: Record<string, unknown>) {
  const res = await api.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}
async function ok(api: Api, path: string, data: Record<string, unknown>) {
  const r = await rpc(api, path, data);
  expect(r.status, `${path} ${JSON.stringify(data)} → ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.result.data;
}
async function getPrefs(api: Api) {
  const res = await api.get(`/api/trpc/${NAMES.prefsGet}`);
  expect(res.ok(), `${NAMES.prefsGet} → ${res.status()}`).toBe(true);
  return (await res.json()).result.data as {
    digestCadence: string;
    digestHour: number;
    digestWeekday: number;
    showDetails: boolean;
    timezone: string | null;
  };
}
/** Run the whole-instance digest batch at an injected clock (synchronous send). */
async function batchRun(api: Api, nowIso: string) {
  const res = await api.post(DEV.digestRun, { data: { batch: true, now: nowIso } });
  expect(res.ok(), `digest-run batch @ ${nowIso} → ${res.status()}`).toBe(true);
}

// =============================================================================

test('daily cadence: sends at the send-hour, silent off-hour, idempotent same day', async () => {
  const anon = await playwrightRequest.newContext({ baseURL: BASE });
  const startRowid = maxCapturedRowid();
  try {
    setDigestPrefs(USER, { cadence: 'daily', hour: HOUR, weekday: 0, tz: 'UTC' });

    // Off-hour → nothing (the batch runs but nia's hour doesn't match).
    await batchRun(anon, OFF_HOUR);
    expect(digestRowsFor(startRowid, EMAIL.nia)).toHaveLength(0);

    // On-hour → exactly one digest, through the subscription pipeline.
    await batchRun(anon, AT_HOUR);
    const rows = digestRowsFor(startRowid, EMAIL.nia);
    expect(rows).toHaveLength(1);
    expect(rows[0].pipeline).toBe('subscription');
    // A digest is bulk mail → RFC-8058 unsubscribe headers present.
    const headers = JSON.parse(rows[0].headersJson || '{}') as Record<string, string>;
    expect(Object.keys(headers).some((k) => k.toLowerCase() === 'list-unsubscribe')).toBe(true);
    // Daily wording: the shares window is "today", not "this week".
    expect(rows[0].textBody).toMatch(/today/i);
    expect(rows[0].textBody).not.toMatch(/this week/i);

    // Same-day rerun at the send-hour → no duplicate (lastDigestAt guard).
    await batchRun(anon, AT_HOUR);
    expect(digestRowsFor(startRowid, EMAIL.nia)).toHaveLength(1);
  } finally {
    resetDigest(USER);
    sweepCapturedAbove(startRowid);
    await anon.dispose();
  }
});

test('weekly cadence: sends only on the chosen weekday', async () => {
  const anon = await playwrightRequest.newContext({ baseURL: BASE });
  const startRowid = maxCapturedRowid();
  try {
    setDigestPrefs(USER, { cadence: 'weekly', hour: HOUR, weekday: RIGHT_WD, tz: 'UTC' });

    // Wrong weekday (next day, same hour) → nothing.
    await batchRun(anon, NEXT_DAY_AT_HOUR);
    expect(digestRowsFor(startRowid, EMAIL.nia)).toHaveLength(0);

    // The chosen weekday at the send-hour → one weekly digest.
    await batchRun(anon, AT_HOUR);
    const rows = digestRowsFor(startRowid, EMAIL.nia);
    expect(rows).toHaveLength(1);
    expect(rows[0].pipeline).toBe('subscription');
    // Weekly wording: the shares window is "this week".
    expect(rows[0].textBody).toMatch(/this week/i);
  } finally {
    resetDigest(USER);
    sweepCapturedAbove(startRowid);
    await anon.dispose();
  }
});

test('off cadence: never sends, even at a matching hour', async () => {
  const anon = await playwrightRequest.newContext({ baseURL: BASE });
  const startRowid = maxCapturedRowid();
  try {
    setDigestPrefs(USER, { cadence: 'off', hour: HOUR, weekday: RIGHT_WD, tz: 'UTC' });
    await batchRun(anon, AT_HOUR);
    expect(digestRowsFor(startRowid, EMAIL.nia)).toHaveLength(0);
  } finally {
    resetDigest(USER);
    sweepCapturedAbove(startRowid);
    await anon.dispose();
  }
});

test('cadence prefs CRUD through the notification router', async () => {
  const nia = await apiLogin(USER);
  try {
    // Seeded default: daily, 9am, Sunday.
    const before = await getPrefs(nia);
    expect(before.digestCadence).toBe('daily');
    expect(before.digestHour).toBe(9);
    expect(before.digestWeekday).toBe(0);

    // Switch to weekly + a new hour; weekday is untouched.
    await ok(nia, NAMES.setPrefs, { digestCadence: 'weekly', digestHour: 7 });
    const a1 = await getPrefs(nia);
    expect(a1.digestCadence).toBe('weekly');
    expect(a1.digestHour).toBe(7);
    expect(a1.digestWeekday).toBe(0);

    // Set a weekday, then back to daily; hour stays where we left it.
    await ok(nia, NAMES.setPrefs, { digestCadence: 'daily', digestWeekday: 3 });
    const a2 = await getPrefs(nia);
    expect(a2.digestCadence).toBe('daily');
    expect(a2.digestWeekday).toBe(3);
    expect(a2.digestHour).toBe(7);

    // Out-of-range / bad values are rejected (not 200).
    expect((await rpc(nia, NAMES.setPrefs, { digestHour: 25 })).status).not.toBe(200);
    expect((await rpc(nia, NAMES.setPrefs, { digestHour: -1 })).status).not.toBe(200);
    expect((await rpc(nia, NAMES.setPrefs, { digestWeekday: 9 })).status).not.toBe(200);
    expect((await rpc(nia, NAMES.setPrefs, { digestCadence: 'nonsense' })).status).not.toBe(200);
  } finally {
    resetDigest(USER);
    await nia.dispose();
  }
});

test('/unsub one-click flips the digest cadence to off; a later run is skipped', async () => {
  const anon = await playwrightRequest.newContext({ baseURL: BASE });
  const startRowid = maxCapturedRowid();
  try {
    setDigestPrefs(USER, { cadence: 'daily', hour: HOUR, weekday: 0, tz: 'UTC' });

    // Produce a digest so we can read its digest-category List-Unsubscribe token.
    await batchRun(anon, AT_HOUR);
    const rows = digestRowsFor(startRowid, EMAIL.nia);
    expect(rows).toHaveLength(1);
    const token = unsubTokenFromHeaders(rows[0].headersJson);

    // RFC-8058 one-click: an UNAUTHENTICATED POST flips the digest cadence off.
    const res = await anon.post(`${DEV.unsub}?token=${encodeURIComponent(token)}`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: 'List-Unsubscribe=One-Click',
    });
    expect(res.ok(), `one-click unsub → ${res.status()}`).toBe(true);
    expect(readCadence(USER)).toBe('off');

    // A FRESH daily window (next day, same hour) would have sent were cadence
    // still daily; cadence=off means no new digest lands.
    await batchRun(anon, NEXT_DAY_AT_HOUR);
    expect(digestRowsFor(startRowid, EMAIL.nia)).toHaveLength(1); // still just the first
  } finally {
    resetDigest(USER);
    sweepCapturedAbove(startRowid);
    await anon.dispose();
  }
});

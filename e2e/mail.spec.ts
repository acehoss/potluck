import { execFileSync } from 'node:child_process';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiLogin } from './helpers';

/**
 * Round-A (Phase 3) capture-mode mail proof. The fixture stack runs
 * MAIL_MODE=capture (the default), so every send the app attempts writes a
 * `CapturedEmail` row and NOTHING touches SMTP. This spec drives the seeded dev
 * trigger route (`/api/dev/mail-test`, gated SEED_DEMO=1 like the push sink) and
 * reads the resulting row back through the better-sqlite3 container seam to
 * assert the two invariants the pipelines must hold:
 *   - a transactional send carries NO List-Unsubscribe header;
 *   - a subscription send carries List-Unsubscribe + List-Unsubscribe-Post.
 * The dev-filter's redirect/regex matrix is proven in the pure unit test
 * (src/server/mail/dev-filter.unit.test.ts) — one env can't exercise those
 * branches end-to-end.
 *
 * INTEGRATION NOTE: awaits mail-server's `/api/dev/mail-test` route + the
 * CapturedEmail table/migration. Runs on both engines (chromium-light,
 * webkit-dark) on the coordinator's gate stack.
 */

const RUN = Date.now().toString(36);

/** Run a Node one-liner inside the app container (connections.spec.ts:44). */
function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

type CapturedRow = {
  id: string;
  pipeline: string;
  kind: string;
  toAddress: string;
  originalTo: string;
  subject: string;
  headersJson: string;
  delivered: number; // sqlite boolean
};

/** Read one CapturedEmail row by id through the container seam. */
function readCaptured(id: string): CapturedRow | null {
  const out = execInApp(
    `const Database = require('better-sqlite3');
     const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
     const row = db.prepare('SELECT id, pipeline, kind, toAddress, originalTo, subject, headersJson, delivered FROM CapturedEmail WHERE id = ?').get(${JSON.stringify(id)});
     process.stdout.write(JSON.stringify(row ?? null));`,
  );
  return JSON.parse(out.trim() || 'null');
}

/** FK-free teardown: drop every row this run created (connections.spec pattern). */
function sweep(project: string) {
  execInApp(
    `const Database = require('better-sqlite3');
     const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
     db.prepare('DELETE FROM CapturedEmail WHERE originalTo LIKE ?').run(${JSON.stringify(`%${RUN}-${project}%`)});`,
  );
}

type MailTestBody = {
  to: string;
  kind?: string;
  pipeline?: 'transactional' | 'subscription';
  userId?: string; // required by the route for subscription sends
  category?: string;
  subject?: string; // the route defaults it; the live suite sets a unique one for IMAP correlation
};
type MailTestResult = { ok: boolean; capturedId: string | null; skipped?: string | null };

/** POST the dev trigger and return the route's raw result. */
async function postMail(ctx: APIRequestContext, body: MailTestBody): Promise<MailTestResult> {
  const res = await ctx.post('/api/dev/mail-test', { data: body });
  expect(res.ok(), `mail-test route should be enabled on the seeded stack (got ${res.status()})`).toBe(true);
  return (await res.json()) as MailTestResult;
}

/** POST the dev trigger for the happy path; asserts a row was written. */
async function triggerMail(ctx: APIRequestContext, body: MailTestBody): Promise<string> {
  const json = await postMail(ctx, body);
  expect(json.ok).toBe(true);
  expect(json.capturedId, 'route returns the CapturedEmail id').toBeTruthy();
  return json.capturedId!;
}

/** Insert / remove a MailSuppression row through the container seam. */
function suppress(email: string) {
  execInApp(
    `const Database = require('better-sqlite3');
     const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
     db.prepare("INSERT OR REPLACE INTO MailSuppression (email, reason) VALUES (?, 'e2e')").run(${JSON.stringify(email)});`,
  );
}
function unsuppress(email: string) {
  execInApp(
    `const Database = require('better-sqlite3');
     const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
     db.prepare('DELETE FROM MailSuppression WHERE email = ?').run(${JSON.stringify(email)});`,
  );
}

function headers(row: CapturedRow): Record<string, string> {
  return JSON.parse(row.headersJson || '{}');
}

/** Case-insensitive header lookup — header names are not case-sensitive. */
function hasHeader(h: Record<string, string>, name: string): boolean {
  return Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());
}

test.describe('mail capture pipeline', () => {
  test('transactional send is captured with NO List-Unsubscribe header', async ({}, testInfo) => {
    const project = testInfo.project.name;
    const ctx = await apiLogin('aaron');
    try {
      const to = `verify-${RUN}-${project}@example.com`;
      const id = await triggerMail(ctx, { to, kind: 'verify', pipeline: 'transactional' });

      const row = readCaptured(id);
      expect(row, 'a CapturedEmail row was written').not.toBeNull();
      expect(row!.pipeline).toBe('transactional');
      expect(row!.kind).toBe('verify');
      expect(row!.originalTo).toBe(to);

      const h = headers(row!);
      expect(hasHeader(h, 'List-Unsubscribe'), 'transactional must NOT carry List-Unsubscribe').toBe(false);
      expect(hasHeader(h, 'List-Unsubscribe-Post')).toBe(false);
    } finally {
      sweep(project);
      await ctx.dispose();
    }
  });

  test('subscription send is captured WITH List-Unsubscribe + List-Unsubscribe-Post', async ({}, testInfo) => {
    const project = testInfo.project.name;
    const ctx = await apiLogin('aaron');
    try {
      const to = `digest-${RUN}-${project}@example.com`;
      const id = await triggerMail(ctx, { to, kind: 'digest', pipeline: 'subscription', userId: 'e2e-mailtest' });

      const row = readCaptured(id);
      expect(row, 'a CapturedEmail row was written').not.toBeNull();
      expect(row!.pipeline).toBe('subscription');
      expect(row!.kind).toBe('digest');

      const h = headers(row!);
      expect(hasHeader(h, 'List-Unsubscribe'), 'subscription MUST carry List-Unsubscribe').toBe(true);
      expect(hasHeader(h, 'List-Unsubscribe-Post'), 'one-click unsubscribe header present').toBe(true);

      // The header must be a well-formed value even though Round C honors the
      // token — a bare/empty header would fail RFC 8058 one-click.
      const listUnsub = Object.entries(h).find(([k]) => k.toLowerCase() === 'list-unsubscribe')![1];
      expect(listUnsub).toMatch(/<[^>]+>/); // at least one <URI> form
    } finally {
      sweep(project);
      await ctx.dispose();
    }
  });

  test('capture mode never marks a row delivered (SMTP untouched)', async ({}, testInfo) => {
    const project = testInfo.project.name;
    const ctx = await apiLogin('aaron');
    try {
      const to = `nosend-${RUN}-${project}@example.com`;
      const id = await triggerMail(ctx, { to, kind: 'test', pipeline: 'transactional' });
      const row = readCaptured(id);
      expect(row, 'row written').not.toBeNull();
      // delivered=false in capture mode: the app recorded the intent but did
      // NOT reach SMTP (the whole point of the default stack).
      expect(Boolean(row!.delivered)).toBe(false);
    } finally {
      sweep(project);
      await ctx.dispose();
    }
  });

  test('suppression gates SUBSCRIPTION only — transactional bypasses it and still records', async ({}, testInfo) => {
    const project = testInfo.project.name;
    const ctx = await apiLogin('aaron');
    const to = `suppressed-${RUN}-${project}@example.com`;
    try {
      suppress(to);

      // Subscription to a suppressed address: no send, no CapturedEmail row.
      const sub = await postMail(ctx, { to, kind: 'digest', pipeline: 'subscription', userId: 'e2e-mailtest' });
      expect(sub.ok).toBe(true);
      expect(sub.capturedId, 'a suppressed subscription is never attempted').toBeFalsy();
      expect(sub.skipped).toBe('suppressed');

      // Transactional to the SAME suppressed address: sent anyway (account-
      // critical mail ignores the suppression list) and a row IS written.
      const txId = await triggerMail(ctx, { to, kind: 'verify', pipeline: 'transactional' });
      const row = readCaptured(txId);
      expect(row, 'transactional to a suppressed address still records').not.toBeNull();
      expect(row!.pipeline).toBe('transactional');
      expect(hasHeader(headers(row!), 'List-Unsubscribe')).toBe(false);
    } finally {
      unsuppress(to);
      sweep(project);
      await ctx.dispose();
    }
  });
});

/**
 * OPT-IN real-send suite (contract A2.3). Self-skips unless MAIL_LIVE is set —
 * it is run ONLY via `npm run e2e:mail`, which boots a scoped MAIL_MODE=live
 * stack against the real DreamHost SMTP/IMAP and the TEST_USER_* live mailboxes,
 * then tears it down. The coordinator runs this once at the gate; DO NOT run it
 * in the normal suite (rate limits + external dependency).
 *
 * It proves the live pipeline end-to-end: trigger a real transactional send to
 * TEST_USER_1, confirm the app marked the row delivered, then poll TEST_USER_1's
 * IMAP inbox until the message lands and its subject matches what the app
 * recorded. `imapflow` is imported LAZILY so the capture tests above never
 * depend on it being installed.
 *
 * INTEGRATION NOTE: needs mail-server to add `imapflow` as a devDependency
 * (requested via message). The `e2e:mail` script sources `.env` so the
 * TEST_USER and EMAIL_IMAP creds reach the playwright process for the IMAP login.
 */
test.describe('mail live delivery', () => {
  test('real send: transactional mail reaches TEST_USER_1 via DreamHost', async ({}, testInfo) => {
    // Self-skip in the normal suite; only `npm run e2e:mail` sets MAIL_LIVE.
    test.skip(!process.env.MAIL_LIVE, 'run via `npm run e2e:mail` (opt-in live send)');
    test.setTimeout(120_000); // IMAP round-trip + delivery latency exceed the 30s default.

    const to = process.env.TEST_USER_1_EMAIL;
    const pass = process.env.TEST_USER_1_PASSWORD;
    const imapHost = process.env.EMAIL_IMAP_SERVER;
    const imapPort = Number(process.env.EMAIL_IMAP_PORT ?? '993');
    const from = process.env.EMAIL_FROM;
    // Fail loudly (not skip) — MAIL_LIVE was set, so these MUST be present.
    expect(to, 'TEST_USER_1_EMAIL must be set for the live suite').toBeTruthy();
    expect(pass, 'TEST_USER_1_PASSWORD must be set').toBeTruthy();
    expect(imapHost, 'EMAIL_IMAP_SERVER must be set').toBeTruthy();

    const project = testInfo.project.name;
    const sinceDate = new Date(Date.now() - 60_000); // IMAP SINCE has day granularity; also filtered by subject.
    const ctx = await apiLogin('aaron');
    let capturedId: string | null = null;
    try {
      // Unique subject so the IMAP poll can't false-match a message from an
      // earlier run (IMAP SINCE is day-granular; MAIL_DEV_SUBJECT_PREFIX is
      // unset on the e2e:mail stack so the subject arrives verbatim).
      const uniqueSubject = `Potluck live test ${RUN}-${project}-${Date.now()}`;
      capturedId = await triggerMail(ctx, { to: to!, kind: 'test', pipeline: 'transactional', subject: uniqueSubject });
      const row = readCaptured(capturedId);
      expect(row, 'CapturedEmail row written').not.toBeNull();
      // The scoped live stack allowlists the recipient, so it delivers as-is
      // and the row is flagged delivered. This is the live-pipeline proof
      // BEFORE we even reach IMAP.
      expect(row!.toAddress, 'delivered to the real recipient, not a redirect').toBe(to);
      expect(Boolean(row!.delivered), 'live mode flags the row delivered').toBe(true);
      const wantSubject = row!.subject;

      // Poll IMAP until the message arrives (delivery is not instantaneous).
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({
        host: imapHost!,
        port: imapPort,
        secure: true,
        auth: { user: to!, pass: pass! },
        logger: false,
      });
      await client.connect();
      let foundSubject: string | null = null;
      try {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && !foundSubject) {
          const lock = await client.getMailboxLock('INBOX');
          try {
            const uids = await client.search({ since: sinceDate, from: from! }, { uid: true });
            if (uids && uids.length) {
              for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
                if (msg.envelope?.subject === wantSubject) {
                  foundSubject = msg.envelope.subject;
                  break;
                }
              }
            }
          } finally {
            lock.release();
          }
          if (!foundSubject) await new Promise((r) => setTimeout(r, 3_000));
        }
      } finally {
        await client.logout().catch(() => {});
      }
      expect(foundSubject, `a message from ${from} titled "${wantSubject}" landed in TEST_USER_1's inbox`).toBe(
        wantSubject,
      );
    } finally {
      if (capturedId) {
        execInApp(
          `const Database = require('better-sqlite3');
           const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
           db.prepare('DELETE FROM CapturedEmail WHERE id = ?').run(${JSON.stringify(capturedId)});`,
        );
      }
      // Best-effort: leave the delivered test message in the live mailbox for
      // the operator to inspect; only sweep the local capture row. (project
      // referenced to keep the signature parallel with the capture tests.)
      void project;
      await ctx.dispose();
    }
  });
});

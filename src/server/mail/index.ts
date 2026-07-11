/**
 * The mail delivery substrate (Phase 3 Round A; docs/archive/mutual-aid-rework-2026-07.md N1–N11).
 *
 * Two DELIBERATELY SEPARATE pipelines so the two classes of mail can never be
 * confused at a call site:
 *
 *   sendTransactional — account-critical mail the user asked for by acting
 *     (verify, password reset, MFA code). It has NO List-Unsubscribe header and
 *     NEVER consults preferences or the suppression list: you cannot
 *     unsubscribe from the reset email you just requested. (CAN-SPAM /
 *     RFC-8058 both scope unsubscribe to bulk/subscription mail.)
 *
 *   sendSubscription — bulk/opt-in mail (digests, share alerts). It carries
 *     RFC-8058 one-click List-Unsubscribe headers and is gated behind the
 *     suppression list and the per-user preference check BEFORE delivery.
 *
 * Everything either pipeline tries to send is written to the CapturedEmail
 * audit table first, whether or not it is actually handed to SMTP — that row
 * is the single source of truth for "what did the app try to send", and the
 * e2e/dev flows read it back. Real SMTP send happens only in MAIL_MODE=live and
 * only for the recipients the fail-closed dev-filter approves. An SMTP failure
 * is logged and swallowed (mirroring push): mail must never break the caller's
 * request path.
 *
 * The suppression/preference HOOKS below are stubs with their Round-C
 * signatures already fixed — Round C fills the bodies (MailSuppression
 * population + NotificationPreference lookup) without touching call sites.
 *
 * TESTABILITY: `deliver`/`sendTransactional`/`sendSubscription` each take an
 * optional `Partial<MailDeps>` that defaults to the real impls. It exists so a
 * unit test can inject a spy `send` + force `isSuppressed`/`subscriptionAllowed`
 * and prove, e.g., that transactional still sends when suppression says "true".
 * Production call sites pass nothing and get the real transport + DB sink.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { db } from '../db';
import { emailAllowed } from '../notifications';
import { mailConfig, mailMode } from './config';
import { resolveRecipients } from './dev-filter';
import { subscriptionHeaders, type SubscriptionCategory } from './unsub';

// Re-exported so the pure token/header builders and their category type have a
// single public entry point (`@/server/mail`) even though they live in the
// db-free ./unsub module (unit-testable without the Prisma client).
export {
  subscriptionHeaders,
  unsubToken,
  verifyUnsubToken,
  type SubscriptionCategory,
} from './unsub';

export type TransactionalKind = 'verify' | 'reset' | 'mfa' | 'test';
export type SubscriptionKind = 'digest' | 'test' | 'pickups' | 'circle' | 'ledger';

/** The already-resolved message an SMTP `send` implementation receives. */
export type OutgoingMessage = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  headers: Record<string, string>;
};

/** The row `capture` writes to the CapturedEmail audit table. */
export type CapturedEmailInput = {
  pipeline: 'transactional' | 'subscription';
  kind: string;
  toAddress: string;
  originalTo: string;
  fromAddress: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  headersJson: string;
  delivered: boolean;
};

/**
 * The four seams the pipelines depend on. Every field has a real default
 * (below); tests override only what they need.
 */
export type MailDeps = {
  isSuppressed: (email: string) => Promise<boolean>;
  subscriptionAllowed: (userId: string, category: SubscriptionCategory) => Promise<boolean>;
  send: (msg: OutgoingMessage) => Promise<void>;
  capture: (row: CapturedEmailInput) => Promise<{ id: string }>;
};

// --- dev-filter env plumbing -------------------------------------------------

function splitEnv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True on an explicit production stack — the dev-filter is then a no-op. */
function isProduction(): boolean {
  return process.env.MAIL_PRODUCTION === '1';
}

// --- Round-C hooks (stable signatures; bodies land in Round C) ---------------

/**
 * Whether an address is on the hard-suppression list (bounces, spam
 * complaints, one-click unsubscribes). Round A: the MailSuppression table
 * exists but nothing populates it yet, so in practice this is always false.
 * Round C keeps this signature and its query is already real.
 */
export async function isSuppressed(email: string): Promise<boolean> {
  const row = await db.mailSuppression.findUnique({ where: { email } });
  return row !== null;
}

/**
 * Whether a user still wants a given subscription category (Round C — the hook
 * Round A stubbed). `digest` consults `User.digestCadence` (allowed unless
 * 'off'); the three notification categories consult the per-(user,category)
 * email flag, falling back to the default matrix when no row exists (an un-tuned
 * account still gets pickups email but not circle/ledger). One-click /unsub sets
 * the digest cadence to 'off', so a later send here returns false and
 * `sendSubscription` skips it.
 */
export async function subscriptionAllowed(
  userId: string,
  category: SubscriptionCategory,
): Promise<boolean> {
  if (category === 'digest') {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { digestCadence: true },
    });
    return user ? user.digestCadence !== 'off' : false;
  }
  return emailAllowed(userId, category);
}

// --- Transport (lazy singleton) ----------------------------------------------

let cachedTransport: Transporter | null = null;
function transport(): Transporter | null {
  const cfg = mailConfig();
  if (!cfg) return null;
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      requireTLS: !cfg.smtp.secure, // STARTTLS on 587
      auth: cfg.smtp.auth,
    });
  }
  return cachedTransport;
}

// --- Real dep implementations (defaults) -------------------------------------

async function realSend(msg: OutgoingMessage): Promise<void> {
  const tx = transport();
  if (!tx) throw new Error('SMTP is not configured (EMAIL_* env incomplete)');
  await tx.sendMail({
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    headers: msg.headers,
  });
}

async function realCapture(row: CapturedEmailInput): Promise<{ id: string }> {
  return db.capturedEmail.create({ data: row, select: { id: true } });
}

const defaultDeps: MailDeps = {
  isSuppressed,
  subscriptionAllowed,
  send: realSend,
  capture: realCapture,
};

// --- The delivery primitive --------------------------------------------------

type DeliverInput = {
  pipeline: 'transactional' | 'subscription';
  kind: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Pipeline-specific extra headers (List-Unsubscribe for subscription). */
  headers?: Record<string, string>;
};

export type DeliverResult = { capturedId: string; delivered: boolean };

/**
 * Record + (in live mode, past the dev-filter) send one message. Always writes
 * a CapturedEmail audit row via `deps.capture`; only calls `deps.send` when
 * MAIL_MODE=live and the dev-filter approves at least one recipient. Never
 * throws — a send error is logged and swallowed so it cannot break the
 * caller's request path; the audit row still persists.
 */
async function deliver(msg: DeliverInput, deps: MailDeps): Promise<DeliverResult> {
  const production = isProduction();
  const resolved = resolveRecipients({
    to: msg.to,
    subject: msg.subject,
    allowlist: splitEnv(process.env.MAIL_DEV_ALLOWLIST),
    redirect: splitEnv(process.env.MAIL_DEV_REDIRECT),
    subjectPrefix: production ? '' : process.env.MAIL_DEV_SUBJECT_PREFIX || '',
    production,
  });

  const from = mailConfig()?.from || process.env.EMAIL_FROM || 'no-reply@potluckmutualaid.app';
  const headers: Record<string, string> = { ...(msg.headers ?? {}) };
  if (resolved.xOriginalTo) headers['X-Original-To'] = resolved.xOriginalTo;

  const wantsSend = mailMode() === 'live' && !resolved.captureOnly && resolved.deliverTo.length > 0;
  let delivered = false;

  if (wantsSend) {
    try {
      await deps.send({
        from,
        to: resolved.deliverTo,
        subject: resolved.subject,
        text: msg.text,
        html: msg.html,
        headers,
      });
      delivered = true;
    } catch (e) {
      // Log and swallow — the CapturedEmail row still persists below.
      console.error('[mail] send failed:', e instanceof Error ? e.message : e);
    }
  }

  const row = await deps.capture({
    pipeline: msg.pipeline,
    kind: msg.kind,
    toAddress: resolved.deliverTo.join(', '),
    originalTo: msg.to,
    fromAddress: from,
    subject: resolved.subject,
    textBody: msg.text,
    htmlBody: msg.html ?? null,
    headersJson: JSON.stringify(headers),
    delivered,
  });

  return { capturedId: row.id, delivered };
}

// --- Pipeline: transactional -------------------------------------------------

/**
 * Account-critical mail. No List-Unsubscribe, no preference/suppression check —
 * a verify/reset/MFA message is always sent (subject to the dev-filter and
 * MAIL_MODE). Always records a CapturedEmail row. `deps` is a test seam;
 * production callers omit it.
 */
export function sendTransactional(
  msg: { to: string; kind: TransactionalKind; subject: string; text: string; html?: string },
  deps: Partial<MailDeps> = {},
): Promise<DeliverResult> {
  return deliver(
    {
      pipeline: 'transactional',
      kind: msg.kind,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    },
    { ...defaultDeps, ...deps },
  );
}

// --- Pipeline: subscription --------------------------------------------------

/**
 * Bulk/opt-in mail. Carries RFC-8058 one-click unsubscribe headers and is
 * gated behind the suppression list and the per-user preference check BEFORE
 * delivery. When suppressed or opted out, no CapturedEmail row is written and
 * `capturedId` is null — the message was never attempted. `deps` is a test
 * seam; production callers omit it.
 */
export async function sendSubscription(
  msg: {
    to: string;
    userId: string;
    category: SubscriptionCategory;
    kind: SubscriptionKind;
    subject: string;
    text: string;
    html?: string;
  },
  deps: Partial<MailDeps> = {},
): Promise<{ capturedId: string | null; delivered: boolean; skipped?: 'suppressed' | 'opted-out' }> {
  const d = { ...defaultDeps, ...deps };
  if (await d.isSuppressed(msg.to)) {
    return { capturedId: null, delivered: false, skipped: 'suppressed' };
  }
  if (!(await d.subscriptionAllowed(msg.userId, msg.category))) {
    return { capturedId: null, delivered: false, skipped: 'opted-out' };
  }
  return deliver(
    {
      pipeline: 'subscription',
      kind: msg.kind,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: subscriptionHeaders(msg.userId, msg.category, msg.to),
    },
    d,
  );
}

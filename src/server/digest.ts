/**
 * The weekly digest (Phase 3 Round C; docs/REWORK.md N6). The home for all
 * ambient/nice-to-know mail — the ONE place a Walt (email-native, never installs
 * the PWA, tunes out past ~5–6 mails/week) still hears about the neighborhood.
 * Scannable + subject front-loads the point ("you're owed $12, 1 pickup
 * waiting"). Assembled from existing state only — balances, open loops, new
 * shares — and sent through the RFC-8058 subscription pipeline (one-click
 * unsubscribe + suppression + the digest opt-out honored before send).
 *
 * Idempotent per user per weekly window via `User.lastDigestAt` (a restart or a
 * double-run in the same week never double-sends). TZ handling is deliberately
 * pragmatic: `runDigest` sends to users whose LOCAL Sunday send-hour matches
 * now (falling back to UTC when a user has no timezone); the assemble-and-send
 * core (`digestFor`) is the load-bearing part and is exercised directly by the
 * SEED_DEMO dev route, window-bypassed.
 */

import { formatCents } from '@/lib/money';
import { appUrl } from './app-url';
import { db } from './db';
import { deepLinkPath, mintDeepLinkToken } from './deeplink';
import { netByCounterparty } from './ledger';
import { sendSubscription } from './mail';
import { openLoopsFor } from './routers/activity';
import { shareVisible } from './routers/share';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Local hour (0–23) the digest goes out on Sunday. */
const DIGEST_SEND_HOUR = 9;

/** Start of the current UTC week (most recent Sunday 00:00Z) — the idempotency window. */
function weekStart(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back up to Sunday
  return d;
}

/** The user's local {weekday 0–6, hour 0–23} in their IANA zone (UTC fallback). */
function localParts(now: Date, timezone: string | null): { weekday: number; hour: number } {
  const zone = timezone ?? 'UTC';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const wdName = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
    const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '0';
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weekday = Math.max(0, weekdays.indexOf(wdName));
    const hour = Number(hourRaw) % 24; // Intl can emit "24" at midnight
    return { weekday, hour };
  } catch {
    return { weekday: now.getUTCDay(), hour: now.getUTCHours() };
  }
}

type LoopMembership = {
  receiveStock: boolean;
  fulfill: boolean;
  spend: boolean;
  manageConnections: boolean;
};

type HouseholdSection = {
  householdName: string;
  standings: { counterpartyName: string; cents: number }[]; // +cents = they owe you
  netCents: number;
  waitingOnYou: number;
  newShares: number;
};

/** Assemble one household's digest slice: balances, open loops, new shares this week. */
async function sectionFor(
  householdId: string,
  householdName: string,
  membership: LoopMembership,
  now: Date,
): Promise<HouseholdSection> {
  const weekAgo = new Date(now.getTime() - WEEK_MS);

  const net = await netByCounterparty(householdId);
  const counterpartyIds = [...net.keys()];
  const counterparties = counterpartyIds.length
    ? await db.household.findMany({
        where: { id: { in: counterpartyIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(counterparties.map((h) => [h.id, h.name]));
  const standings = counterpartyIds
    .map((id) => ({ counterpartyName: nameById.get(id) ?? 'A household', cents: net.get(id) ?? 0 }))
    .filter((s) => s.cents !== 0)
    .sort((a, b) => b.cents - a.cents);
  const netCents = standings.reduce((sum, s) => sum + s.cents, 0);

  const loops = await openLoopsFor(householdId, membership);
  const waitingOnYou = loops.actionableCount;

  // New shares this week from connections that this household can still see.
  const candidates = await db.sharePost.findMany({
    where: {
      householdId: { not: householdId },
      status: { in: ['OPEN', 'CLAIMED'] },
      expiresAt: { gt: now },
      createdAt: { gt: weekAgo },
    },
    select: { householdId: true },
  });
  let newShares = 0;
  const visibleCache = new Map<string, boolean>();
  for (const c of candidates) {
    let vis = visibleCache.get(c.householdId);
    if (vis === undefined) {
      vis = await shareVisible(db, c.householdId, householdId);
      visibleCache.set(c.householdId, vis);
    }
    if (vis) newShares += 1;
  }

  return { householdName, standings, netCents, waitingOnYou, newShares };
}

/** A one-line net-balance phrase for a household (subject/body scannability). */
function balancePhrase(netCents: number): string {
  if (netCents > 0) return `you're owed ${formatCents(netCents)}`;
  if (netCents < 0) return `you owe ${formatCents(-netCents)}`;
  return 'balances settled';
}

function renderSubject(sections: HouseholdSection[]): string {
  const netCents = sections.reduce((s, sec) => s + sec.netCents, 0);
  const waiting = sections.reduce((s, sec) => s + sec.waitingOnYou, 0);
  const parts = [balancePhrase(netCents)];
  if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? 'thing' : 'things'} waiting on you`);
  return `Your Potluck week: ${parts.join(', ')}`;
}

function renderBody(userName: string, sections: HouseholdSection[], openLink: string | null): string {
  const lines: string[] = [`Hi ${userName}, here's your Potluck week.`, ''];
  for (const sec of sections) {
    lines.push(`— ${sec.householdName} —`);
    if (sec.standings.length === 0) {
      lines.push('Balances: all settled up.');
    } else {
      lines.push('Balances:');
      for (const s of sec.standings) {
        const phrase =
          s.cents > 0
            ? `${s.counterpartyName} owes you ${formatCents(s.cents)}`
            : `you owe ${s.counterpartyName} ${formatCents(-s.cents)}`;
        lines.push(`  • ${phrase}`);
      }
    }
    lines.push(
      `Waiting on you: ${sec.waitingOnYou === 0 ? 'nothing right now' : `${sec.waitingOnYou} to handle`}`,
    );
    lines.push(
      `New shares from neighbors this week: ${sec.newShares === 0 ? 'none' : sec.newShares}`,
    );
    lines.push('');
  }
  lines.push(
    openLink ? `Open Potluck to act on anything above: ${openLink}` : 'Open Potluck to act on anything above.',
  );
  return lines.join('\n');
}

export type DigestResult = {
  sent: boolean;
  capturedId: string | null;
  reason?: 'opted-out' | 'already-sent' | 'no-household';
};

/**
 * Assemble + send one user's digest. `force` bypasses the weekly-window
 * idempotency guard (the dev route uses it so e2e can trigger on demand); the
 * digest opt-out is ALWAYS honored (via `sendSubscription`, and short-circuited
 * here). Sets `lastDigestAt` on a real send so the batch never double-fires.
 */
export async function digestFor(
  userId: string,
  opts: { now?: Date; force?: boolean } = {},
): Promise<DigestResult> {
  const now = opts.now ?? new Date();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      email: true,
      digestOptOut: true,
      lastDigestAt: true,
      memberships: {
        select: {
          householdId: true,
          receiveStock: true,
          fulfill: true,
          spend: true,
          manageConnections: true,
          household: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!user) return { sent: false, capturedId: null };
  if (user.digestOptOut) return { sent: false, capturedId: null, reason: 'opted-out' };
  if (user.memberships.length === 0) return { sent: false, capturedId: null, reason: 'no-household' };
  if (!opts.force && user.lastDigestAt && user.lastDigestAt >= weekStart(now)) {
    return { sent: false, capturedId: null, reason: 'already-sent' };
  }

  const sections: HouseholdSection[] = [];
  for (const m of user.memberships) {
    sections.push(await sectionFor(m.householdId, m.household.name, m, now));
  }

  // Nav-only CTA (N7): opens /activity switched to the recipient's default
  // (first) household. The subject/body stay generic (N4) — the /go link is
  // opaque.
  const openLink = appUrl(
    deepLinkPath(mintDeepLinkToken({ path: '/activity', householdId: user.memberships[0].householdId })),
  );

  const res = await sendSubscription({
    to: user.email,
    userId,
    category: 'digest',
    kind: 'digest',
    subject: renderSubject(sections),
    text: renderBody(user.name, sections, openLink),
  });

  // A send that the subscription gate skipped (suppressed/opted-out) leaves the
  // watermark untouched — nothing went out, so a later window may still try.
  if (res.capturedId) {
    await db.user.update({ where: { id: userId }, data: { lastDigestAt: now } });
    return { sent: true, capturedId: res.capturedId };
  }
  return {
    sent: false,
    capturedId: null,
    reason: res.skipped === 'opted-out' ? 'opted-out' : undefined,
  };
}

/**
 * Batch entry point: send this week's digest to every user whose LOCAL Sunday
 * send-hour matches `now` and who hasn't been sent this window. Meant to be
 * poked by an EXTERNAL cron on an authenticated trigger (self-hosted compose
 * model) — no in-process scheduler this round. Returns a per-user tally.
 */
export async function runDigest(now: Date = new Date()): Promise<{ sent: number; considered: number }> {
  const users = await db.user.findMany({
    where: { digestOptOut: false },
    select: { id: true, timezone: true, lastDigestAt: true },
  });
  const window = weekStart(now);
  let sent = 0;
  let considered = 0;
  for (const u of users) {
    const { weekday, hour } = localParts(now, u.timezone);
    if (weekday !== 0 || hour !== DIGEST_SEND_HOUR) continue;
    if (u.lastDigestAt && u.lastDigestAt >= window) continue;
    considered += 1;
    const res = await digestFor(u.id, { now });
    if (res.sent) sent += 1;
  }
  return { sent, considered };
}

/**
 * The digest (Phase 3 Round C + the digest-cadence round; docs/archive/mutual-aid-rework-2026-07.md N6).
 * The home for all ambient/nice-to-know mail — the ONE place a Walt (email-
 * native, never installs the PWA, tunes out past ~5–6 mails/week) still hears
 * about the neighborhood. Scannable + subject front-loads the point ("you're
 * owed $12, 1 pickup waiting"). Assembled from existing state only — balances,
 * open loops, new shares — and sent through the RFC-8058 subscription pipeline
 * (one-click unsubscribe + suppression + the cadence honored before send).
 *
 * Per-user CADENCE ('off'|'daily'|'weekly') with a per-user local send hour, and
 * (weekly only) a send weekday. `runDigest` sends to each user whose LOCAL send
 * hour matches now — for weekly, also their chosen weekday — falling back to UTC
 * when a user has no timezone. Idempotent per user per CADENCE WINDOW via
 * `User.lastDigestAt` (the window is the local day for daily, the local week-
 * since-their-weekday for weekly), so a restart, an in-process scheduler tick,
 * or a double-run inside the same window never double-sends. The "new shares"
 * lookback follows the cadence too (24h daily / 7d weekly), and the body line
 * reads "today" vs "this week". The assemble-and-send core (`digestFor`) is the
 * load-bearing part and is exercised directly by the SEED_DEMO dev route,
 * window-bypassed.
 */

import { formatCents } from '@/lib/money';
import { appUrl } from './app-url';
import { db } from './db';
import { deepLinkPath, mintDeepLinkToken } from './deeplink';
import { netByCounterparty } from './ledger';
import { sendSubscription } from './mail';
import { openLoopsFor } from './open-loops';
import {
  chainEdgesAlive,
  loadScopeCircleIds,
  postVisibleToConnection,
  sharePosterReachByHousehold,
} from './share-reach';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONNECTION_WITH_CIRCLES = { aCircle: true, bCircle: true } as const;

export type DigestCadence = 'off' | 'daily' | 'weekly';

/** The "new shares" lookback for a cadence: daily → 24h, weekly → 7d. */
function lookbackMs(cadence: DigestCadence): number {
  return cadence === 'daily' ? DAY_MS : WEEK_MS;
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

/**
 * The user's local calendar day as 'YYYY-MM-DD' in their zone (UTC fallback).
 * This is the idempotency key: a digest fires at most once per LOCAL DAY, and
 * the cadence gate (weekly only fires on the user's `digestWeekday`) makes that
 * effectively once-per-week for weekly. DST-proof by construction — it never
 * does offset arithmetic, it just asks the zone what day it is.
 */
function localDayKey(now: Date, timezone: string | null): string {
  const zone = timezone ?? 'UTC';
  try {
    // 'en-CA' formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** True when a real send already happened in this user's current local day. */
function alreadySentThisWindow(
  lastDigestAt: Date | null,
  now: Date,
  timezone: string | null,
): boolean {
  if (!lastDigestAt) return false;
  return localDayKey(lastDigestAt, timezone) === localDayKey(now, timezone);
}

/** The per-user due fields the batch gate reads (a subset of the User row). */
export type DigestDueUser = {
  timezone: string | null;
  digestCadence: string;
  digestHour: number;
  digestWeekday: number;
  lastDigestAt: Date | null;
};

/**
 * Pure "is a digest owed to this user at `now`?" gate — the single decision
 * `runDigest` applies to every user each tick, factored out so it is unit-
 * testable without a DB. A user is due when: cadence isn't 'off'; their LOCAL
 * send hour matches `digestHour`; for 'weekly', their local weekday also matches
 * `digestWeekday`; and no send already landed in their current local-day window.
 * Runs at 1-hour resolution (so every tick inside the matching hour is due until
 * the first send stamps the window).
 */
export function digestDue(user: DigestDueUser, now: Date): boolean {
  const cadence = user.digestCadence as DigestCadence;
  if (cadence === 'off') return false;
  const { weekday, hour } = localParts(now, user.timezone);
  if (hour !== user.digestHour) return false;
  if (cadence === 'weekly' && weekday !== user.digestWeekday) return false;
  if (alreadySentThisWindow(user.lastDigestAt, now, user.timezone)) return false;
  return true;
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

/** Assemble one household's digest slice: balances, open loops, new shares this period. */
async function sectionFor(
  householdId: string,
  householdName: string,
  membership: LoopMembership,
  now: Date,
  since: Date,
): Promise<HouseholdSection> {
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

  // New shares this period from connections that this household can still see.
  const [candidates, connections] = await Promise.all([
    db.sharePost.findMany({
      where: {
        householdId: { not: householdId },
        status: { in: ['OPEN', 'CLAIMED'] },
        expiresAt: { gt: now },
        createdAt: { gt: since },
      },
      select: { id: true, householdId: true, visibility: true, parentPostId: true },
    }),
    db.connection.findMany({
      where: { status: 'ACTIVE', OR: [{ householdAId: householdId }, { householdBId: householdId }] },
      include: CONNECTION_WITH_CIRCLES,
    }),
  ]);
  const reachByPoster = sharePosterReachByHousehold(connections, householdId);
  const scopeIdsByPost = await loadScopeCircleIds(
    db,
    candidates.filter((c) => c.visibility === 'SELECT').map((c) => c.id),
  );
  let newShares = 0;
  for (const c of candidates) {
    const reach = reachByPoster.get(c.householdId);
    if (!reach) continue;
    if (
      !postVisibleToConnection(
        { visibility: c.visibility, scopeCircleIds: scopeIdsByPost.get(c.id) ?? [] },
        reach.posterSideCircleId,
      )
    ) {
      continue;
    }
    // A reshare copy whose upstream chain died is gone from the feed — don't
    // count it in the digest either (mirrors the feed's chainEdgesAlive rule).
    if (c.parentPostId && !(await chainEdgesAlive(db, c))) continue;
    newShares += 1;
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

function renderBody(
  userName: string,
  sections: HouseholdSection[],
  openLink: string | null,
  cadence: DigestCadence,
): string {
  const period = cadence === 'daily' ? 'today' : 'this week';
  const lines: string[] = [`Hi ${userName}, here's your Potluck ${cadence === 'daily' ? 'day' : 'week'}.`, ''];
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
      `New shares from neighbors ${period}: ${sec.newShares === 0 ? 'none' : sec.newShares}`,
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
  reason?: 'opted-out' | 'already-sent' | 'no-household' | 'nothing-to-report';
};

/**
 * Assemble + send one user's digest. `force` bypasses the cadence-window
 * idempotency guard (the dev route uses it so e2e can trigger on demand); a
 * cadence of 'off' is ALWAYS honored (via `sendSubscription`, and short-
 * circuited here). The "new shares" lookback and the body copy follow the
 * user's cadence (daily → 24h/"today", weekly → 7d/"this week"). Sets
 * `lastDigestAt` on a real send so the batch never double-fires in-window.
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
      timezone: true,
      digestCadence: true,
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
  const cadence = user.digestCadence as DigestCadence;
  if (cadence === 'off') return { sent: false, capturedId: null, reason: 'opted-out' };
  if (user.memberships.length === 0) return { sent: false, capturedId: null, reason: 'no-household' };
  if (!opts.force && alreadySentThisWindow(user.lastDigestAt, now, user.timezone)) {
    return { sent: false, capturedId: null, reason: 'already-sent' };
  }

  const since = new Date(now.getTime() - lookbackMs(cadence));
  const sections: HouseholdSection[] = [];
  for (const m of user.memberships) {
    sections.push(await sectionFor(m.householdId, m.household.name, m, now, since));
  }

  // Nothing to say → don't send an empty "all caught up" nag, and DON'T stamp
  // lastDigestAt: the watermark only advances on a real send, so a later window
  // that DOES find content still fires (matches the cadence-guard convention).
  if (
    sections.every((s) => s.standings.length === 0 && s.waitingOnYou === 0 && s.newShares === 0)
  ) {
    return { sent: false, capturedId: null, reason: 'nothing-to-report' };
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
    text: renderBody(user.name, sections, openLink, cadence),
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
 * Batch entry point: send the digest to every user whose cadence is due at
 * `now`. A user is due when their LOCAL send hour matches (`digestHour`), for
 * `weekly` also their local weekday (`digestWeekday`), and no send has already
 * landed in their current local-day window (idempotent via `lastDigestAt`).
 * Driven by the in-process scheduler (`src/instrumentation.ts`) on a ~10-minute
 * tick, and still callable from the `run-digest` CLI as a cron fallback. Runs
 * at 1-hour resolution, so several ticks inside the matching hour all resolve to
 * the same window and only the first sends. Returns a per-user tally.
 */
export async function runDigest(now: Date = new Date()): Promise<{ sent: number; considered: number }> {
  const users = await db.user.findMany({
    where: { digestCadence: { not: 'off' } },
    select: {
      id: true,
      timezone: true,
      lastDigestAt: true,
      digestCadence: true,
      digestHour: true,
      digestWeekday: true,
    },
  });
  let sent = 0;
  let considered = 0;
  for (const u of users) {
    if (!digestDue(u, now)) continue;
    considered += 1;
    const res = await digestFor(u.id, { now });
    if (res.sent) sent += 1;
  }
  return { sent, considered };
}

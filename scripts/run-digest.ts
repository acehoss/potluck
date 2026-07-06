/**
 * Digest trigger — the CRON FALLBACK for when the in-process scheduler is off
 * (DIGEST_SCHEDULER=off). By default the app runs digests itself on a ~10-min
 * tick (src/instrumentation.ts), so this script is only needed as an external
 * cron alternative.
 *
 * CRON (no args) — run HOURLY from an external cron on the Docker host:
 *   0 * * * *  cd /path/to/coop && docker compose exec -T app npx tsx scripts/run-digest.ts
 * `runDigest(now)` sends only to users whose cadence is due at `now` (LOCAL send
 * hour matches; for weekly, also the local weekday) and who haven't been sent in
 * their current local-day window (idempotent via User.lastDigestAt), so an
 * hourly cron sweeps every timezone and never double-sends; it is a cheap no-op
 * off-window.
 *
 * SMOKE TEST (one arg) — force one user's digest NOW, bypassing the cadence
 * window (a cadence of 'off' is still honored):
 *   docker compose exec -T app npx tsx scripts/run-digest.ts you@example.com
 * Useful to verify a fresh deployment's mail path end to end. It stamps that
 * user's watermark for the CURRENT local day only, so it won't suppress the
 * next real scheduled send.
 */
import { db } from '../src/server/db';
import { digestFor, runDigest } from '../src/server/digest';

async function main() {
  const identifier = process.argv[2]?.trim().toLowerCase();

  if (identifier) {
    const user = await db.user.findFirst({
      where: identifier.includes('@') ? { email: identifier } : { username: identifier },
      select: { id: true },
    });
    if (!user) {
      console.error(`[run-digest] no user matches "${identifier}"`);
      process.exit(1);
    }
    const r = await digestFor(user.id, { force: true });
    console.log(`[run-digest] forced ${identifier}: sent=${r.sent}${r.reason ? ` (${r.reason})` : ''}`);
    process.exit(r.sent ? 0 : 1);
  }

  const r = await runDigest(new Date());
  console.log(`[run-digest] sent ${r.sent} / considered ${r.considered}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[run-digest] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

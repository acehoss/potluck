/** Next.js instrumentation hook: runs once at server boot. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { sweepOrphanImages } = await import('./server/image-sweep');
    const removed = await sweepOrphanImages();
    if (removed > 0) console.log(`[image-sweep] removed ${removed} orphaned image file(s)`);
  } catch (err) {
    // Best-effort GC — never block startup on it.
    console.warn('[image-sweep] skipped:', err);
  }

  startDigestScheduler();
}

/**
 * In-process digest scheduler (the digest-cadence round). A ~10-minute tick that
 * drives `runDigest(now)` so the app itself sends daily/weekly digests — no
 * external cron needed for the self-hosted default. `run-digest.ts` stays as a
 * manual/cron fallback (set DIGEST_SCHEDULER=off to use it instead).
 *
 * Deliberately defensive so it can NEVER take the server down:
 *   - gated to the nodejs runtime + DIGEST_SCHEDULER !== 'off' (default ON);
 *   - wrapped so a throw here never blocks boot;
 *   - no immediate boot tick (a restart storm would each fire a sweep) — the
 *     first tick is one interval in;
 *   - an in-flight guard so a slow sweep never overlaps the next tick;
 *   - each tick's own try/catch (a bad sweep is logged, never thrown);
 *   - `unref()` so the timer never holds the process open at shutdown.
 * Quiet by design: it only logs when a tick actually sends (>0).
 */
function startDigestScheduler() {
  try {
    if (process.env.DIGEST_SCHEDULER === 'off') return;

    const INTERVAL_MS = 10 * 60 * 1000; // ~10 min; runDigest is a cheap off-window no-op
    let inFlight = false;

    const timer = setInterval(() => {
      if (inFlight) return; // never overlap a slow sweep
      inFlight = true;
      void (async () => {
        try {
          const { runDigest } = await import('./server/digest');
          const res = await runDigest(new Date());
          if (res.sent > 0) {
            console.log(`[digest-scheduler] sent ${res.sent} / considered ${res.considered}`);
          }
          // Backstop drain for transactional notifications whose post-commit
          // send was interrupted (Phase 4 Round 4 outbox) — late, never lost.
          const { drainNotifyOutbox } = await import('./server/notify-outbox');
          const drained = await drainNotifyOutbox();
          if (drained > 0) console.log(`[digest-scheduler] outbox drained ${drained}`);
        } catch (err) {
          console.warn('[digest-scheduler] tick failed:', err instanceof Error ? err.message : err);
        } finally {
          inFlight = false;
        }
      })();
    }, INTERVAL_MS);

    timer.unref?.();
    console.log('[digest-scheduler] armed (every ~10m; quiet unless it sends)');
  } catch (err) {
    // A failure to even schedule must not block boot.
    console.warn('[digest-scheduler] not started:', err instanceof Error ? err.message : err);
  }
}

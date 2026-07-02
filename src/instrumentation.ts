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
}

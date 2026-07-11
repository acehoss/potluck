/**
 * Notification-category defaults — the PURE, db-free spine of Round C's channel
 * matrix (docs/archive/mutual-aid-rework-2026-07.md N5). Kept in its own leaf (no `./db` import, so no
 * Prisma client is constructed on import) precisely so it can be unit-tested
 * with `tsx --test` and shared by both the notify fan-out (`push.ts`) and the
 * mail subscription gate (`mail/index.ts`). The db-bound lookups that build on
 * this table live in `../notifications.ts`, which re-exports everything here.
 *
 * Three stored, opt-out categories. An ABSENT NotificationPreference row means
 * the category default below; a present row (always both channels — the model
 * columns are non-null) overrides it outright. Deliberate defaults: ledger
 * (settlement/adjustment) is push+email OFF — money noise is opt-in; circle
 * (neighborhood activity, e.g. a new share) is push ON / email OFF, so a share
 * reaches visible connections IMMEDIATELY while the leftovers are still good,
 * but the per-share EMAIL stays off (the daily digest is the email path — a
 * per-share email would spam the digest-only "Walt" users). (`account`
 * transactional mail is never stored here; `digest` is the User-level cadence,
 * not a channel matrix.)
 */

export type NotifyCategory = 'pickups' | 'circle' | 'ledger';

export const NOTIFY_CATEGORIES: readonly NotifyCategory[] = ['pickups', 'circle', 'ledger'];

export type ChannelPrefs = { push: boolean; email: boolean };

export const CATEGORY_DEFAULTS: Record<NotifyCategory, ChannelPrefs> = {
  pickups: { push: true, email: true },
  circle: { push: true, email: false },
  ledger: { push: false, email: false },
};

export function isNotifyCategory(value: string): value is NotifyCategory {
  return (NOTIFY_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The effective channel prefs for a category given its stored row (or null for
 * absent → default). Always returns a FRESH object — never the shared default
 * constant by reference — so a caller mutating the result can't poison the next
 * lookup.
 */
export function resolveChannelPrefs(
  category: NotifyCategory,
  row: ChannelPrefs | null,
): ChannelPrefs {
  return row ? { push: row.push, email: row.email } : { ...CATEGORY_DEFAULTS[category] };
}

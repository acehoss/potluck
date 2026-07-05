/**
 * Notification-category defaults — the PURE, db-free spine of Round C's channel
 * matrix (docs/REWORK.md N5). Kept in its own leaf (no `./db` import, so no
 * Prisma client is constructed on import) precisely so it can be unit-tested
 * with `tsx --test` and shared by both the notify fan-out (`push.ts`) and the
 * mail subscription gate (`mail/index.ts`). The db-bound lookups that build on
 * this table live in `../notifications.ts`, which re-exports everything here.
 *
 * Three stored, opt-out categories. An ABSENT NotificationPreference row means
 * the category default below; a present row (always both channels — the model
 * columns are non-null) overrides it outright. The deliberate N5 change: ledger
 * (settlement/adjustment) defaults push+email OFF — money noise is opt-in.
 * (`account` transactional mail is never stored here; `digest` is a single
 * User-level opt-out, not a channel matrix.)
 */

export type NotifyCategory = 'pickups' | 'circle' | 'ledger';

export const NOTIFY_CATEGORIES: readonly NotifyCategory[] = ['pickups', 'circle', 'ledger'];

export type ChannelPrefs = { push: boolean; email: boolean };

export const CATEGORY_DEFAULTS: Record<NotifyCategory, ChannelPrefs> = {
  pickups: { push: true, email: true },
  circle: { push: false, email: false },
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

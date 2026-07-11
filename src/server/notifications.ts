/**
 * Notification-preference resolution (Phase 3 Round C; docs/archive/mutual-aid-rework-2026-07.md N4/N5/N6)
 * — the db-bound half. The pure default table + `resolveChannelPrefs` live in
 * `./notify/defaults` (db-free, unit-testable); this module re-exports them and
 * adds the Prisma lookups the notify fan-out (`push.ts`) and the mail
 * subscription gate (`mail/index.ts`) share. Keeping the pure spine separate
 * avoids constructing the Prisma client just to read the default matrix.
 *
 * An ABSENT NotificationPreference row means the category DEFAULT, so a fresh
 * account carries zero rows and still behaves conservatively (N5).
 */

import { db } from './db';
import {
  CATEGORY_DEFAULTS,
  type ChannelPrefs,
  NOTIFY_CATEGORIES,
  type NotifyCategory,
  resolveChannelPrefs,
} from './notify/defaults';

export {
  CATEGORY_DEFAULTS,
  type ChannelPrefs,
  isNotifyCategory,
  NOTIFY_CATEGORIES,
  type NotifyCategory,
  resolveChannelPrefs,
} from './notify/defaults';

/** The effective channel prefs for one user + category (pref row, else default). */
export async function channelPrefs(
  userId: string,
  category: NotifyCategory,
): Promise<ChannelPrefs> {
  const row = await db.notificationPreference.findUnique({
    where: { userId_category: { userId, category } },
  });
  return resolveChannelPrefs(category, row);
}

/**
 * The effective channel prefs for many users at once, keyed by userId — one
 * query for the notify fan-out. Users with no row for the category fall back to
 * the default; the returned map has an entry for EVERY requested userId.
 */
export async function channelPrefsForUsers(
  userIds: string[],
  category: NotifyCategory,
): Promise<Map<string, ChannelPrefs>> {
  const out = new Map<string, ChannelPrefs>();
  for (const id of userIds) out.set(id, { ...CATEGORY_DEFAULTS[category] });
  if (userIds.length === 0) return out;
  const rows = await db.notificationPreference.findMany({
    where: { userId: { in: userIds }, category },
  });
  for (const r of rows) out.set(r.userId, { push: r.push, email: r.email });
  return out;
}

/** Whether a user's EMAIL channel is on for a notification category (default-aware). */
export async function emailAllowed(userId: string, category: NotifyCategory): Promise<boolean> {
  return (await channelPrefs(userId, category)).email;
}

/** The full matrix a user currently sees — every category, resolved to defaults. */
export async function effectivePrefs(userId: string): Promise<Record<NotifyCategory, ChannelPrefs>> {
  const rows = await db.notificationPreference.findMany({ where: { userId } });
  const byCat = new Map(rows.map((r) => [r.category, r]));
  const out = {} as Record<NotifyCategory, ChannelPrefs>;
  for (const cat of NOTIFY_CATEGORIES) {
    const r = byCat.get(cat);
    out[cat] = resolveChannelPrefs(cat, r ? { push: r.push, email: r.email } : null);
  }
  return out;
}

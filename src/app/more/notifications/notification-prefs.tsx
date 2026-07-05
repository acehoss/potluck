'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { Switch } from './switch';

/**
 * Notification preferences (Phase-3 Round C, decisions N4/N5). The category
 * matrix: for each of the three stored categories a push + email choice, then a
 * weekly digest, a "show details" privacy toggle, and (optional) a time zone for
 * digest timing. Labels follow the Walt rule — plain language, no "push
 * category" jargon. Everything writes through the `notification` tRPC router;
 * absent-pref defaults come resolved from the server so a toggle reflects the
 * true current state (an unset category still shows its N5 default).
 *
 * Push vs. email are independent channels; the push toggle here reflects the
 * category-level opt-in, while turning push ON for *this device* still lives in
 * the "This device" NotificationsCard on More (a device needs a subscription
 * before any category can reach it).
 */

type Category = 'pickups' | 'circle' | 'ledger';
type Channel = 'push' | 'email';

type Prefs = {
  categories: Record<Category, { push: boolean; email: boolean }>;
  digestOptOut: boolean;
  showDetails: boolean;
  timezone: string | null;
  onboarded: boolean;
};

const CATEGORY_COPY: Record<Category, { title: string; blurb: string }> = {
  pickups: {
    title: 'Pickups & things waiting on you',
    blurb: 'Someone wants goods from your pantry, an order is ready, a share was claimed, or a new neighbor asks to connect.',
  },
  circle: {
    title: 'Neighborhood activity',
    blurb: 'New shares posted by households you’re connected with.',
  },
  ledger: {
    title: 'Money & settling up',
    blurb: 'When a settlement or a manual ledger adjustment is recorded.',
  },
};

const card =
  'flex flex-col gap-4 rounded-xl border border-border bg-surface-raised p-4 shadow-sm';

/** IANA zones for the digest-timing select, when the browser can enumerate them. */
function timezoneOptions(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    return supported ?? [];
  } catch {
    return [];
  }
}

export function NotificationPrefs() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const prefsQuery = useQuery(trpc.notification.get.queryOptions());
  const key = trpc.notification.get.queryKey();

  /** Optimistically patch the cached prefs so a toggle reacts instantly. */
  function patch(mutate: (prev: Prefs) => Prefs) {
    const prev = queryClient.getQueryData<Prefs>(key);
    if (prev) queryClient.setQueryData<Prefs>(key, mutate(prev));
    return prev;
  }

  const setChannel = useMutation(
    trpc.notification.setChannel.mutationOptions({
      onMutate: (vars: { category: Category; channel: Channel; enabled: boolean }) => {
        const prev = patch((p) => ({
          ...p,
          categories: {
            ...p.categories,
            [vars.category]: { ...p.categories[vars.category], [vars.channel]: vars.enabled },
          },
        }));
        return { prev };
      },
      onError: (_e, _v, ctx) => {
        if (ctx?.prev) queryClient.setQueryData<Prefs>(key, ctx.prev);
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    }),
  );

  // One mutation for the three scalar prefs; pass only the field that changed.
  const setPrefs = useMutation(
    trpc.notification.setPrefs.mutationOptions({
      onMutate: (vars: { digestOptOut?: boolean; showDetails?: boolean; timezone?: string | null }) => {
        const prev = patch((p) => ({
          ...p,
          ...(vars.digestOptOut !== undefined && { digestOptOut: vars.digestOptOut }),
          ...(vars.showDetails !== undefined && { showDetails: vars.showDetails }),
          ...(vars.timezone !== undefined && { timezone: vars.timezone }),
        }));
        return { prev };
      },
      onError: (_e, _v, ctx) => {
        if (ctx?.prev) queryClient.setQueryData<Prefs>(key, ctx.prev);
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    }),
  );

  if (prefsQuery.isPending) {
    return (
      <section className={card}>
        <p className="text-sm text-text-muted">Loading your notification settings…</p>
      </section>
    );
  }

  if (prefsQuery.isError) {
    return (
      <section className={card}>
        <p role="alert" className="text-sm text-danger">
          {prefsQuery.error.message}
        </p>
      </section>
    );
  }

  const prefs = prefsQuery.data;
  const busy = setChannel.isPending || setPrefs.isPending;
  const zones = timezoneOptions();

  return (
    <div className="flex flex-col gap-4" data-testid="notif-prefs-screen">
      <section className={card}>
        <div>
          <h2 className="text-lg font-semibold text-text">How should we reach you?</h2>
          <p className="text-sm text-text-muted">
            Pick a phone notification, an email, or both for each kind of update. You can change
            this any time.
          </p>
        </div>

        <ul className="flex flex-col divide-y divide-border">
          {(['pickups', 'circle', 'ledger'] as const).map((cat) => (
            <li key={cat} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
              <div>
                <h3 className="font-medium text-text">{CATEGORY_COPY[cat].title}</h3>
                <p className="text-sm text-text-muted">{CATEGORY_COPY[cat].blurb}</p>
              </div>
              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-sm text-text">
                  <Switch
                    checked={prefs.categories[cat].push}
                    disabled={busy}
                    label={`${CATEGORY_COPY[cat].title}: phone notification`}
                    testid={`notif-${cat}-push`}
                    onChange={(enabled) =>
                      setChannel.mutate({ category: cat, channel: 'push', enabled })
                    }
                  />
                  Phone
                </label>
                <label className="flex items-center gap-2 text-sm text-text">
                  <Switch
                    checked={prefs.categories[cat].email}
                    disabled={busy}
                    label={`${CATEGORY_COPY[cat].title}: email`}
                    testid={`notif-${cat}-email`}
                    onChange={(enabled) =>
                      setChannel.mutate({ category: cat, channel: 'email', enabled })
                    }
                  />
                  Email
                </label>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={card}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text">Weekly summary email</h2>
            <p className="text-sm text-text-muted">
              A once-a-week recap: who you owe or are owed, anything still waiting on you, and new
              shares from your neighbors. No amounts or addresses leave the app any other way.
            </p>
          </div>
          {/* Stored as an opt-OUT, so the switch is ON when NOT opted out. */}
          <Switch
            checked={!prefs.digestOptOut}
            disabled={setPrefs.isPending}
            label="Weekly summary email"
            testid="notif-digest"
            onChange={(on) => setPrefs.mutate({ digestOptOut: !on })}
          />
        </div>
      </section>

      <section className={card}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text">Show details in notifications</h2>
            <p className="text-sm text-text-muted">
              Off (the default), a notification just says something is waiting — it never names the
              other household. Turn this on to include their name. Dollar amounts and addresses are
              never in a notification either way.
            </p>
          </div>
          <Switch
            checked={prefs.showDetails}
            disabled={setPrefs.isPending}
            label="Show details in notifications"
            testid="notif-show-details"
            onChange={(showDetails) => setPrefs.mutate({ showDetails })}
          />
        </div>
      </section>

      {zones.length > 0 && (
        <section className={card}>
          <div>
            <h2 className="text-lg font-semibold text-text">Time zone</h2>
            <p className="text-sm text-text-muted">
              When your weekly summary goes out. Leave on the server default if you’re not sure.
            </p>
          </div>
          <select
            data-testid="notif-timezone"
            value={prefs.timezone ?? ''}
            disabled={setPrefs.isPending}
            onChange={(e) => setPrefs.mutate({ timezone: e.target.value || null })}
            className="min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
          >
            <option value="">Server default</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </section>
      )}
    </div>
  );
}

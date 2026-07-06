'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';
import { Switch } from './more/notifications/switch';

/**
 * First-run notification consent (Phase-3 Round C). Surfaced ONCE per account,
 * app-wide just like VerifyBanner: a single "How should Potluck reach you?"
 * screen with the conservative defaults pre-selected and an explicit Save — we
 * never silently flip anything on. Gated on the server's `firstRunSeen` flag
 * (per-account, so it doesn't reappear on every device); dismissing or saving
 * both mark it seen. Hidden on the auth screens and inside the receive wizard,
 * like the header and tab bar.
 *
 * "Save these" materializes the shown choices as preference rows; "Not now"
 * just marks it seen and leaves the system defaults in place (which already
 * match what's pre-selected here — pickups on, the rest off).
 */

type Category = 'pickups' | 'circle' | 'ledger';

const CONSENT_COPY: Record<Category, { title: string; blurb: string }> = {
  pickups: {
    title: 'Pickups & things waiting on you',
    blurb: 'Someone wants goods, an order is ready, or a neighbor asks to connect.',
  },
  circle: {
    title: 'Neighborhood activity',
    blurb: 'New shares from households you’re connected with.',
  },
  ledger: {
    title: 'Money & settling up',
    blurb: 'Settlements and manual ledger adjustments.',
  },
};

// The conservative N5 defaults, pre-selected but never applied without a tap.
const DEFAULTS: Record<Category, { push: boolean; email: boolean }> = {
  pickups: { push: true, email: true },
  circle: { push: true, email: false },
  ledger: { push: false, email: false },
};

const primaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

export function FirstRunConsent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const [choices, setChoices] = useState(DEFAULTS);
  const [digest, setDigest] = useState(true);
  const [done, setDone] = useState(false);

  const onAuthScreen =
    pathname.startsWith('/login') ||
    pathname.startsWith('/invite') ||
    pathname.startsWith('/verify') ||
    pathname.startsWith('/forgot') ||
    pathname.startsWith('/reset') ||
    pathname.includes('/receive/');

  const prefs = useQuery(
    trpc.notification.get.queryOptions(undefined, {
      enabled: !onAuthScreen,
      retry: false,
    }),
  );

  const setChannel = useMutation(trpc.notification.setChannel.mutationOptions());
  const setPrefs = useMutation(trpc.notification.setPrefs.mutationOptions());
  const markOnboarded = useMutation(trpc.notification.markOnboarded.mutationOptions());

  const finish = () => {
    setDone(true);
    void queryClient.invalidateQueries({ queryKey: trpc.notification.get.queryKey() });
  };

  const save = async () => {
    for (const cat of ['pickups', 'circle', 'ledger'] as const) {
      await setChannel.mutateAsync({ category: cat, channel: 'push', enabled: choices[cat].push });
      await setChannel.mutateAsync({
        category: cat,
        channel: 'email',
        enabled: choices[cat].email,
      });
    }
    await setPrefs.mutateAsync({ digestCadence: digest ? 'daily' : 'off' });
    await markOnboarded.mutateAsync();
    finish();
  };

  const notNow = async () => {
    await markOnboarded.mutateAsync();
    finish();
  };

  if (onAuthScreen || done || prefs.data?.onboarded !== false) return null;

  const saving = setChannel.isPending || setPrefs.isPending || markOnboarded.isPending;

  const toggle = (cat: Category, channel: 'push' | 'email') =>
    setChoices((prev) => ({
      ...prev,
      [cat]: { ...prev[cat], [channel]: !prev[cat][channel] },
    }));

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-scrim p-0 sm:items-center sm:p-4">
      <div
        data-testid="notif-firstrun"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <div>
          <h2 className="text-lg font-semibold text-text">How should Potluck reach you?</h2>
          <p className="text-sm text-text-muted">
            Pick a phone notification, an email, or both for each kind of update. You can change any
            of this later in Notifications settings.
          </p>
        </div>

        <ul className="flex flex-col divide-y divide-border">
          {(['pickups', 'circle', 'ledger'] as const).map((cat) => (
            <li key={cat} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
              <div>
                <h3 className="font-medium text-text">{CONSENT_COPY[cat].title}</h3>
                <p className="text-sm text-text-muted">{CONSENT_COPY[cat].blurb}</p>
              </div>
              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-sm text-text">
                  <Switch
                    checked={choices[cat].push}
                    disabled={saving}
                    label={`${CONSENT_COPY[cat].title}: phone notification`}
                    testid={`notif-firstrun-${cat}-push`}
                    onChange={() => toggle(cat, 'push')}
                  />
                  Phone
                </label>
                <label className="flex items-center gap-2 text-sm text-text">
                  <Switch
                    checked={choices[cat].email}
                    disabled={saving}
                    label={`${CONSENT_COPY[cat].title}: email`}
                    testid={`notif-firstrun-${cat}-email`}
                    onChange={() => toggle(cat, 'email')}
                  />
                  Email
                </label>
              </div>
            </li>
          ))}
        </ul>

        <label className="flex items-center justify-between gap-4 border-t border-border pt-3 text-sm text-text">
          <span>
            <span className="font-medium">Weekly summary email</span>
            <span className="block text-text-muted">
              A once-a-week recap of balances, anything waiting, and new shares.
            </span>
          </span>
          <Switch
            checked={digest}
            disabled={saving}
            label="Weekly summary email"
            testid="notif-firstrun-digest"
            onChange={setDigest}
          />
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            data-testid="notif-firstrun-dismiss"
            onClick={notNow}
            disabled={saving}
            className={secondaryBtn}
          >
            Not now
          </button>
          <button
            type="button"
            data-testid="notif-firstrun-save"
            onClick={save}
            disabled={saving}
            className={primaryBtn}
          >
            {saving ? 'Saving…' : 'Save these'}
          </button>
        </div>
      </div>
    </div>
  );
}

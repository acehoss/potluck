'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * iPadOS 13+ reports a desktop "Macintosh" user agent, so the classic
 * iPhone/iPad UA sniff misses modern iPads — the giveaway is a Mac UA with a
 * multi-touch screen (real Macs report 0 touch points).
 */
function isIOSDevice() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

/**
 * PWA cards on /more (blueprint 02 PWA section, 04 §4):
 *
 * - InstallCard: Android/Chrome gets the captured beforeinstallprompt as a
 *   real Install button; iOS (no such API, ever) gets the Share → Add to Home
 *   Screen pictogram steps. Dismissible; hidden once running standalone.
 * - NotificationsCard: explicit opt-in toggle for the two v1 push events.
 *   The permission prompt fires ONLY on the user's tap — never on load.
 */

const card =
  'flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm';
const secondaryBtn =
  'min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';
const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';

const DISMISS_KEY = 'coop-install-card-dismissed';

/** iOS share pictogram (box with up arrow), drawn inline so it matches tokens. */
function ShareIcon() {
  return (
    <svg
      aria-label="Share"
      role="img"
      viewBox="0 0 24 24"
      className="inline size-5 align-text-bottom text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 15V4" />
      <path d="M8.5 7.5 12 4l3.5 3.5" />
      <path d="M6.5 10.5H6a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-2-2h-.5" />
    </svg>
  );
}

export function InstallCard() {
  const [state, setState] = useState<{
    show: boolean;
    isIOS: boolean;
    canPrompt: boolean;
  } | null>(null);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari's legacy standalone flag.
      (navigator as { standalone?: boolean }).standalone === true;
    const dismissed = localStorage.getItem(DISMISS_KEY) === '1';
    const isIOS = isIOSDevice();
    const sync = () =>
      setState({
        show: !standalone && !dismissed,
        isIOS,
        canPrompt: window.__coopInstallPrompt !== undefined,
      });
    sync();
    // beforeinstallprompt may land after mount; PwaSetup re-announces it.
    window.addEventListener('coop:installprompt', sync);
    return () => window.removeEventListener('coop:installprompt', sync);
  }, []);

  if (!state?.show) return null;

  return (
    <section data-testid="install-card" className={card}>
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold">Put Coop on your home screen</h2>
        <button
          type="button"
          aria-label="Dismiss install help"
          data-testid="install-dismiss"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, '1');
            setState((s) => (s ? { ...s, show: false } : s));
          }}
          className="-m-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-sunken"
        >
          ✕
        </button>
      </div>
      <p className="text-sm text-text-muted">
        Installed, it opens full-screen like an app — and it&apos;s the only way to get
        notifications on iPhone.
      </p>
      {state.isIOS ? (
        <ol className="flex flex-col gap-1.5 text-sm text-text" data-testid="install-ios-steps">
          <li>
            1. Tap <ShareIcon /> <span className="font-medium">Share</span>
            {' in Safari’s toolbar'}
          </li>
          <li>
            2. Scroll and tap{' '}
            <span className="font-medium">
              Add to Home Screen{' '}
              <span
                aria-hidden
                className="inline-flex size-5 items-center justify-center rounded-md border border-border-strong align-text-bottom text-xs"
              >
                +
              </span>
            </span>
          </li>
        </ol>
      ) : state.canPrompt ? (
        <button
          type="button"
          data-testid="install-prompt"
          onClick={async () => {
            await window.__coopInstallPrompt?.prompt();
            window.__coopInstallPrompt = undefined;
            setState((s) => (s ? { ...s, canPrompt: false } : s));
          }}
          className={primaryBtn}
        >
          Install app
        </button>
      ) : (
        <p className="text-sm text-text" data-testid="install-generic-hint">
          In Chrome or Edge, open the <span className="font-medium">⋮ menu</span> and choose{' '}
          <span className="font-medium">Add to home screen</span> (or{' '}
          <span className="font-medium">Install app</span>). Installing needs the site served
          over HTTPS.
        </p>
      )}
    </section>
  );
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export function NotificationsCard() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publicKey = useQuery(trpc.push.publicKey.queryOptions());
  const subscribe = useMutation(trpc.push.subscribe.mutationOptions());
  const unsubscribe = useMutation(trpc.push.unsubscribe.mutationOptions());
  // Server truth: an endpoint belongs to its LAST subscriber, so on a shared
  // device the browser subscription may exist but point at someone else's
  // account. "Notifications are on" only when the server confirms this
  // endpoint is the signed-in user's — otherwise the turn-on path stays
  // offered (re-subscribing reassigns the row without a second prompt).
  const status = useQuery(
    trpc.push.status.queryOptions(
      { endpoint: subscription?.endpoint ?? '' },
      { enabled: subscription !== null },
    ),
  );
  const isMine = subscription !== null && status.data?.subscribed === true;
  const belongsToAnother = subscription !== null && status.data?.subscribed === false;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = 'serviceWorker' in navigator && 'PushManager' in window;
      const ios = isIOSDevice();
      if (cancelled) return;
      setIsIOS(ios);
      setSupported(ok);
      if (!ok) return;
      // Passive: read the existing subscription, never prompt on load.
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setSubscription(sub);
      } catch {
        // No SW registration (non-secure context) — leave unsubscribed.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      // serviceWorker.ready never resolves if the SW isn't registering (e.g.
      // automation, or a wedged install) — cap the wait so the button can't
      // sit on "Turning on…" forever.
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Notifications setup timed out — reload and try again.')), 10_000),
        ),
      ]);
      // This is the explicit user tap — the ONLY place the permission prompt
      // is allowed to appear (blueprint 04 §4 / iOS requirement).
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey.data!.publicKey!),
      });
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('Subscription came back incomplete.');
      }
      await subscribe.mutateAsync({
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      });
      setSubscription(sub);
      await queryClient.invalidateQueries(trpc.push.status.pathFilter());
    } catch (e) {
      setError(
        Notification.permission === 'denied'
          ? 'Notifications are blocked for this site — allow them in your browser settings, then try again.'
          : e instanceof Error
            ? e.message
            : 'Could not subscribe.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      const endpoint = subscription?.endpoint;
      await subscription?.unsubscribe();
      if (endpoint) await unsubscribe.mutateAsync({ endpoint });
      setSubscription(null);
      await queryClient.invalidateQueries(trpc.push.status.pathFilter());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not unsubscribe.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="notifications-card" className={card}>
      <h2 className="text-lg font-semibold">Notifications</h2>
      <p className="text-sm text-text-muted">
        A heads-up when someone records a settlement or posts a manual ledger adjustment —
        nothing else.
      </p>
      {supported === false ? (
        <p className="text-sm text-text" data-testid="push-unsupported">
          {isIOS
            ? 'On iPhone/iPad, notifications only work in the installed app (iOS 16.4+) — add Coop to your home screen first.'
            : "This browser doesn't support web push."}
        </p>
      ) : publicKey.data && publicKey.data.publicKey === null ? (
        <p className="text-sm text-text-muted" data-testid="push-not-configured">
          Push isn&apos;t configured on this server (no VAPID keys) — see the README.
        </p>
      ) : isMine ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-success" data-testid="push-on">
            Notifications are on for this device.
          </p>
          <button
            type="button"
            data-testid="push-off-btn"
            onClick={turnOff}
            disabled={busy}
            className={secondaryBtn}
          >
            {busy ? 'Turning off…' : 'Turn off notifications'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {belongsToAnother && (
            <p className="text-sm text-text-muted" data-testid="push-other-user">
              This device&apos;s notifications currently go to a different account — turn them
              on to point them at you instead.
            </p>
          )}
          <button
            type="button"
            data-testid="push-on-btn"
            onClick={turnOn}
            disabled={
              busy ||
              supported === null ||
              !publicKey.data?.publicKey ||
              (subscription !== null && status.data === undefined)
            }
            className={primaryBtn}
          >
            {busy ? 'Turning on…' : 'Turn on notifications'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * Unverified-email nudge (Phase-3 Round B). App-wide, just under the header:
 * when the signed-in account hasn't confirmed its email yet, offer a one-tap
 * resend. Dismissible for the session (sessionStorage) — the account still
 * works unverified this round; this is a reminder, not a gate. Hidden on the
 * auth screens (where there's no session) and inside the receive wizard, like
 * the header and tab bar.
 */
export function VerifyBanner() {
  const trpc = useTRPC();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(false);
  const [sent, setSent] = useState(false);

  const onAuthScreen =
    pathname.startsWith('/login') ||
    pathname.startsWith('/invite') ||
    pathname.startsWith('/verify') ||
    pathname.startsWith('/forgot') ||
    pathname.startsWith('/reset') ||
    pathname.includes('/receive/');

  const status = useQuery(
    trpc.auth.emailStatus.queryOptions(undefined, {
      enabled: !onAuthScreen,
      retry: false,
    }),
  );

  const resend = useMutation(
    trpc.auth.resendVerification.mutationOptions({ onSuccess: () => setSent(true) }),
  );

  if (onAuthScreen || dismissed || status.data?.verified !== false) return null;

  return (
    <div
      data-testid="verify-banner"
      className="flex items-start gap-3 border-b border-border bg-warn-soft px-3 py-2 text-sm text-text"
    >
      <span aria-hidden className="pt-0.5 text-base leading-none">
        ✉️
      </span>
      <div className="flex-1">
        {sent ? (
          <span data-testid="verify-banner-sent">
            Sent — check your inbox for the confirmation link.
          </span>
        ) : (
          <>
            <span>Confirm your email so you can recover your account if you lose your password. </span>
            <button
              type="button"
              data-testid="verify-banner-resend"
              onClick={() => resend.mutate()}
              disabled={resend.isPending}
              className="font-medium text-accent hover:underline disabled:text-text-muted disabled:no-underline"
            >
              {resend.isPending ? 'Sending…' : 'Resend the link'}
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        data-testid="verify-banner-dismiss"
        onClick={() => setDismissed(true)}
        className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-sunken"
      >
        ✕
      </button>
    </div>
  );
}

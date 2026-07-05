'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * Consumes an email-verification token from the link. Runs the mutation once on
 * mount and shows a plain success or a "this link didn't work" state — the same
 * generic outcome for an expired, already-used, or bogus token (never reveals
 * which). Works signed in or out; the link may be opened on any device.
 */
export function VerifyClient({ token }: { token: string }) {
  const trpc = useTRPC();
  const verify = useMutation(trpc.auth.verifyEmail.mutationOptions());
  const { mutate } = verify;

  // A verification token is single-use, so fire exactly once — a second call
  // (e.g. StrictMode's double-invoked effect) would hit the just-consumed token
  // and flip a real success into the "invalid" state.
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    mutate({ token });
  }, [mutate, token]);

  const failed = verify.isError || verify.data?.status === 'invalid';
  const ok = verify.data?.status === 'verified';

  return (
    <div
      data-testid="verify-page"
      className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-6 text-center shadow-sm"
    >
      {verify.isPending || (!ok && !failed) ? (
        <p className="text-sm text-text-muted" data-testid="verify-pending">
          Confirming your email…
        </p>
      ) : ok ? (
        <>
          <p className="text-base font-medium text-success" data-testid="verify-success">
            Your email is confirmed.
          </p>
          <p className="mt-1 text-sm text-text-muted">
            You&apos;re all set — this address can now recover your account.
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast hover:bg-accent-strong"
          >
            Continue
          </Link>
        </>
      ) : (
        <>
          <p className="text-base font-medium text-text" data-testid="verify-invalid">
            This confirmation link didn&apos;t work.
          </p>
          <p className="mt-1 text-sm text-text-muted">
            It may have expired or already been used. Open Potluck and use the “resend” link at the
            top to get a fresh one.
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text hover:bg-surface-sunken"
          >
            Go to Potluck
          </Link>
        </>
      )}
    </div>
  );
}

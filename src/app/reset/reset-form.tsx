'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';

/**
 * Set a new password from a reset link. We first check the token (valid? does
 * this account use two-step sign-in?) so we only ask for a code when the
 * account actually has one — a reset must never be a way around two-step
 * sign-in (the code field is required when requiresMfa). On success all other
 * sessions are signed out server-side.
 */
export function ResetForm({ token }: { token: string }) {
  const trpc = useTRPC();
  const info = useQuery(trpc.auth.resetPasswordInfo.queryOptions({ token }, { retry: false }));
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  const reset = useMutation(trpc.auth.resetPassword.mutationOptions());

  if (info.isPending) {
    return <p className="text-center text-sm text-text-muted">Checking your link…</p>;
  }

  // A bad/expired/used token (or a failed check) — same generic dead end.
  if (info.isError || !info.data?.valid) {
    return (
      <div data-testid="reset-invalid" className="flex flex-col gap-3 text-center">
        <p className="text-base font-medium text-text">This reset link didn&apos;t work.</p>
        <p className="text-sm text-text-muted">
          It may have expired or already been used. Request a new one and try again.
        </p>
        <Link href="/forgot" className="text-sm font-medium text-accent hover:underline">
          Request a new link
        </Link>
      </div>
    );
  }

  if (reset.isSuccess) {
    return (
      <div data-testid="reset-done" className="flex flex-col gap-3 text-center">
        <p className="text-base font-medium text-success">Your password is set.</p>
        <p className="text-sm text-text-muted">
          For safety we signed out your other devices. Sign in with your new password.
        </p>
        <Link
          href="/login"
          data-testid="reset-to-login"
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast hover:bg-accent-strong"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  const requiresMfa = info.data.requiresMfa;

  return (
    <form
      data-testid="reset-form"
      className="flex w-full flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        reset.mutate({
          token,
          newPassword: password,
          code: requiresMfa ? code.trim() : undefined,
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        New password
        <input
          type="password"
          required
          minLength={10}
          data-testid="reset-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className={inputClass}
        />
        <span className="text-xs font-normal text-text-muted">At least 10 characters.</span>
      </label>

      {requiresMfa && (
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Two-step code
          <input
            type="text"
            required
            data-testid="reset-mfa-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            className={inputClass}
          />
          <span className="text-xs font-normal text-text-muted">
            A code from your authenticator app, or one of your backup codes.
          </span>
        </label>
      )}

      {reset.error && (
        <p role="alert" className="text-sm text-danger">
          {reset.error.message}
        </p>
      )}
      <button
        type="submit"
        data-testid="reset-submit"
        disabled={reset.isPending}
        className={primaryBtn}
      >
        {reset.isPending ? 'Saving…' : 'Set new password'}
      </button>
    </form>
  );
}

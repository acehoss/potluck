'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';

/**
 * Request a password-reset link. The result is deliberately the same whether or
 * not an account exists (enumeration-safe): once submitted, we always show the
 * "check your email" note.
 */
export function ForgotForm() {
  const trpc = useTRPC();
  const [identifier, setIdentifier] = useState('');
  const request = useMutation(trpc.auth.requestPasswordReset.mutationOptions());

  if (request.isSuccess) {
    return (
      <div data-testid="forgot-sent" className="flex flex-col gap-3 text-center">
        <p className="text-base font-medium text-text">Check your email</p>
        <p className="text-sm text-text-muted">
          If an account matches what you entered, we&apos;ve sent a link to reset its password. The
          link expires soon, so use it while it&apos;s fresh.
        </p>
        <Link href="/login" className="text-sm font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form
      data-testid="forgot-form"
      className="flex w-full flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        request.mutate({ identifier: identifier.trim() });
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        Username or email
        <input
          type="text"
          name="username"
          required
          autoComplete="username"
          autoCapitalize="none"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className={inputClass}
        />
      </label>
      {request.error && (
        <p role="alert" className="text-sm text-danger">
          {request.error.message}
        </p>
      )}
      <button
        type="submit"
        data-testid="forgot-submit"
        disabled={request.isPending}
        className={primaryBtn}
      >
        {request.isPending ? 'Sending…' : 'Email me a reset link'}
      </button>
      <Link
        href="/login"
        className="text-center text-xs font-medium text-accent hover:underline"
      >
        Back to sign in
      </Link>
    </form>
  );
}

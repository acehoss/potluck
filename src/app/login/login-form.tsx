'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

export function LoginForm() {
  const trpc = useTRPC();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation(
    trpc.auth.login.mutationOptions({
      onSuccess: () => {
        router.push('/');
        router.refresh();
      },
    }),
  );

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        login.mutate({ email, password });
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        Email
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Password
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </label>
      {login.error && (
        <p role="alert" className="text-sm text-danger">
          {login.error.message}
        </p>
      )}
      <button
        type="submit"
        disabled={login.isPending}
        className="rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
      >
        {login.isPending ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="text-center text-xs text-text-muted">
        No account? Ask a member of your household for an invite link.
      </p>
    </form>
  );
}

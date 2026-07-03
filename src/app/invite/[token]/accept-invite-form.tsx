'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';

export function AcceptInviteForm({ token, defaultName }: { token: string; defaultName: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const accept = useMutation(
    trpc.auth.acceptInvite.mutationOptions({
      onSuccess: () => {
        router.push('/');
        router.refresh();
      },
    }),
  );

  return (
    <form
      className="flex w-full flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        accept.mutate({ token, name, email, password });
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        Your name
        <input
          type="text"
          name="name"
          required
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        Email
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        Password
        <input
          type="password"
          name="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
        <span className="text-xs font-normal text-text-muted">At least 10 characters.</span>
      </label>
      {accept.error && (
        <p role="alert" className="text-sm text-danger">
          {accept.error.message}
        </p>
      )}
      <button
        type="submit"
        disabled={accept.isPending}
        className="min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70"
      >
        {accept.isPending ? 'Creating account…' : 'Join household'}
      </button>
    </form>
  );
}

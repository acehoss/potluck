'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

const inputClass =
  'rounded-lg border border-stone-300 bg-white px-3 py-2 text-base outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100';

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
      className="flex w-full max-w-sm flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        accept.mutate({ token, name, email, password });
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
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
      <label className="flex flex-col gap-1 text-sm font-medium">
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
      <label className="flex flex-col gap-1 text-sm font-medium">
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
        <span className="text-xs font-normal text-stone-400">At least 10 characters.</span>
      </label>
      {accept.error && (
        <p role="alert" className="text-sm text-red-600">
          {accept.error.message}
        </p>
      )}
      <button
        type="submit"
        disabled={accept.isPending}
        className="rounded-lg bg-emerald-700 px-4 py-2.5 font-medium text-white transition-colors hover:bg-emerald-800 disabled:opacity-50"
      >
        {accept.isPending ? 'Creating account…' : 'Join household'}
      </button>
    </form>
  );
}

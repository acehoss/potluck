'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTRPC } from '@/lib/trpc';

export function LogoutButton() {
  const trpc = useTRPC();
  const router = useRouter();

  const logout = useMutation(
    trpc.auth.logout.mutationOptions({
      onSuccess: () => {
        router.push('/login');
        router.refresh();
      },
    }),
  );

  return (
    <button
      type="button"
      onClick={() => logout.mutate()}
      disabled={logout.isPending}
      className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
    >
      Sign out
    </button>
  );
}

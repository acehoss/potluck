'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * Inline add-a-pantry affordance for the OWN household group on the Pantries
 * tab — the first thing a household founded through an invite needs (they
 * start with none). Rendered only for manageHousehold holders.
 */
export function AddPantry() {
  const trpc = useTRPC();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(
    trpc.pantry.create.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setName('');
        setError(null);
        router.refresh();
      },
      onError: (e) => setError(e.message),
    }),
  );

  if (!open) {
    return (
      <button
        type="button"
        data-testid="add-pantry"
        onClick={() => setOpen(true)}
        className="min-h-11 rounded-lg border border-dashed border-border-strong px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-surface-sunken"
      >
        + Add a pantry
      </button>
    );
  }
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate({ name });
      }}
    >
      <input
        type="text"
        required
        autoFocus
        data-testid="add-pantry-name"
        placeholder="Basement shelves"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="min-h-11 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
      />
      <button
        type="submit"
        data-testid="add-pantry-save"
        disabled={create.isPending}
        className="min-h-11 shrink-0 rounded-lg bg-accent px-4 py-2 font-medium text-accent-contrast hover:bg-accent-strong disabled:bg-accent/50"
      >
        Add
      </button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

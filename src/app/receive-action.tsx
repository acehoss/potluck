'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Receive quick-action, shared by the global header (🧺) and the Home tab FAB
 * (Round E: "make sure the header Receive and Home FAB share one component").
 * One own pantry → straight to its page (where the +Receive flow lives); several
 * → a small chooser sheet. The caller gates on receiveStock + pantries.length
 * (can/hide) — this component assumes it should render.
 */
export function ReceiveAction({
  pantries,
  testId,
  className,
  children,
  ariaLabel = 'Receive a shopping trip',
}: {
  pantries: { id: string; name: string }[];
  testId: string;
  className: string;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const go = () => {
    if (pantries.length === 1) {
      router.push(`/pantries/${pantries[0].id}`);
    } else {
      setOpen(true);
    }
  };

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        onClick={go}
        className={className}
      >
        {children}
      </button>

      {open && (
        <div
          data-testid="receive-pantry-sheet"
          className="fixed inset-0 z-30 flex items-start justify-center bg-scrim p-4 pt-16"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Receive into which pantry?</h2>
            <ul className="flex flex-col gap-1">
              {pantries.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/pantries/${p.id}`}
                    data-testid="receive-pantry-option"
                    onClick={() => setOpen(false)}
                    className="flex min-h-11 items-center rounded-lg border border-border px-3 font-medium text-text hover:bg-surface-sunken"
                  >
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTRPC } from '@/lib/trpc';
import { scaleAmount } from '../../scale';
import { splitSteps } from '../../steps';
import type { RecipeDto } from '../../types';

/**
 * Cook mode (Round R centerpiece, PTE-informed). A hands-free, phone-on-the-
 * counter stepper: one big step at a time up top, an independently scrollable
 * tap-to-check ingredient list below. Advance by swipe, big buttons, or the
 * keyboard; the screen stays awake; your place survives a trip to the shopping
 * list (sessionStorage). No editing here — that's the view page, one tap back.
 */

type WakeSentinel = { release?: () => Promise<void> };
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeSentinel> };
};

const SWIPE_THRESHOLD = 48; // px of horizontal travel that counts as a step swipe

export function CookView({ id }: { id: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.recipe.get.queryOptions({ id }, { retry: false }));

  if (query.isLoading) {
    return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  }
  if (query.isError || !query.data) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center gap-3 p-6 pb-24 text-center">
        <p className="text-4xl" aria-hidden>
          🤷
        </p>
        <p className="text-base font-medium text-text">This recipe isn&apos;t available.</p>
        <Link href="/recipes" className="text-sm text-accent underline">
          Back to your book
        </Link>
      </div>
    );
  }

  // Keyed remount per recipe so all the cook-session state resets cleanly.
  return <CookScreen key={query.data.id} recipe={query.data as RecipeDto} />;
}

function CookScreen({ recipe }: { recipe: RecipeDto }) {
  const router = useRouter();
  const steps = useMemo(() => splitSteps(recipe.directions), [recipe.directions]);
  const total = steps.length;
  const storageKey = `potluck-cook:${recipe.id}`;

  const base = recipe.servings ?? null;
  const [target, setTarget] = useState<number>(base ?? 1);
  const factor = base && base > 0 ? target / base : 1;

  const [stepIndex, setStepIndex] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    try {
      const raw = sessionStorage.getItem(storageKey);
      const n = raw != null ? parseInt(raw, 10) : 0;
      if (Number.isFinite(n) && n >= 0 && n < total) return n;
    } catch {
      // Private mode / quota — start at the top.
    }
    return 0;
  });
  const [checked, setChecked] = useState<Set<string>>(() => new Set());

  const go = useCallback(
    (delta: number) => {
      setStepIndex((i) => {
        const next = i + delta;
        return next < 0 || next >= total ? i : next;
      });
    },
    [total],
  );

  // Persist the step index so leaving to check the shopping list keeps our place.
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, String(stepIndex));
    } catch {
      // ignore — persistence is a convenience, not a requirement
    }
  }, [stepIndex, storageKey]);

  // Keyboard: Space / → advance, ← goes back. Ignore while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  // Wake lock: keep the screen on while cooking; re-acquire when the tab
  // returns to foreground (the lock is dropped on tab-hide). Feature-detected.
  useEffect(() => {
    const nav = navigator as WakeLockNavigator;
    if (!nav.wakeLock) return;
    let sentinel: WakeSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const s = await nav.wakeLock!.request('screen');
        if (cancelled) {
          s.release?.().catch(() => {});
          return;
        }
        sentinel = s;
      } catch {
        // A denied lock (background tab, unsupported) is non-fatal.
      }
    };
    void acquire();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      sentinel?.release?.().catch(() => {});
    };
  }, []);

  // Horizontal swipe on the step pane (the crop-sheet pointer pattern).
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events may reject capture — the swipe math still works.
    }
    swipeStart.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      go(dx < 0 ? 1 : -1);
    }
  };

  function toggle(ingredientId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(ingredientId)) next.delete(ingredientId);
      else next.add(ingredientId);
      return next;
    });
  }

  const stepperBtn =
    'flex size-10 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-surface">
      {/* Header: exit + live servings scaler. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          data-testid="cook-done"
          onClick={() => router.push(`/recipes/${recipe.id}`)}
          aria-label="Done cooking"
          className="min-h-11 shrink-0 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text hover:bg-surface-sunken"
        >
          ✕ Done
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{recipe.title}</h1>
        {base != null && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-testid="cook-servings-minus"
              aria-label="Fewer servings"
              disabled={target <= 1}
              onClick={() => setTarget((t) => Math.max(1, t - 1))}
              className={stepperBtn}
            >
              −
            </button>
            <span
              data-testid="cook-servings-value"
              className="w-12 text-center font-mono text-sm tabular-nums text-text"
            >
              {target}
              <span className="block text-[10px] font-normal text-text-muted">servings</span>
            </span>
            <button
              type="button"
              data-testid="cook-servings-plus"
              aria-label="More servings"
              onClick={() => setTarget((t) => t + 1)}
              className={stepperBtn}
            >
              +
            </button>
          </div>
        )}
      </header>

      {/* TOP pane: the current step, big. Swipe to move. */}
      <section
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipeStart.current = null)}
        className="flex min-h-0 flex-1 touch-pan-y select-none flex-col gap-3 overflow-y-auto px-5 py-6"
      >
        {total > 0 ? (
          <>
            <p data-testid="cook-step-counter" className="text-sm font-medium text-text-muted">
              Step {stepIndex + 1} of {total}
            </p>
            <p
              data-testid="cook-step"
              aria-live="polite"
              className="text-2xl leading-snug font-medium text-text"
            >
              {steps[stepIndex]}
            </p>
          </>
        ) : (
          <p className="text-base text-text-muted">
            This recipe has no written steps — the ingredients are below.
          </p>
        )}
      </section>

      {/* BOTTOM pane: independently scrollable, tap-to-check ingredients. */}
      <section className="flex max-h-[40vh] shrink-0 flex-col overflow-y-auto border-t border-border bg-surface-sunken">
        <h2 className="sticky top-0 bg-surface-sunken px-5 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Ingredients
        </h2>
        <ul className="flex flex-col gap-1 px-3 pb-3">
          {recipe.ingredients.map((ing) =>
            ing.kind === 'heading' ? (
              <li
                key={ing.id}
                className="px-2 pt-2 text-xs font-medium uppercase tracking-wide text-text-muted"
              >
                {ing.text}
              </li>
            ) : (
              <li key={ing.id}>
                <button
                  type="button"
                  data-testid="cook-ingredient"
                  aria-pressed={checked.has(ing.id)}
                  onClick={() => toggle(ing.id)}
                  className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-raised ${
                    checked.has(ing.id) ? 'opacity-40 line-through' : ''
                  }`}
                >
                  {ing.amount && (() => {
                    const s = scaleAmount(ing.amount, factor);
                    return (
                      <span className="shrink-0 font-mono text-sm tabular-nums text-text">
                        {s.approx && '~'}
                        {s.display}
                      </span>
                    );
                  })()}
                  {ing.unit && <span className="shrink-0 text-sm text-text-muted">{ing.unit}</span>}
                  <span className="min-w-0 text-base text-text">{ing.text}</span>
                </button>
              </li>
            ),
          )}
        </ul>
      </section>

      {/* Prev / next: big targets for floury hands. */}
      {total > 0 && (
        <footer className="flex shrink-0 gap-3 border-t border-border px-4 py-3">
          <button
            type="button"
            data-testid="cook-prev"
            aria-label="Previous step"
            disabled={stepIndex <= 0}
            onClick={() => go(-1)}
            className="flex min-h-12 flex-1 items-center justify-center rounded-lg border border-border-strong text-base font-medium text-text hover:bg-surface-sunken disabled:opacity-40"
          >
            ← Prev
          </button>
          <button
            type="button"
            data-testid="cook-next"
            aria-label="Next step"
            disabled={stepIndex >= total - 1}
            onClick={() => go(1)}
            className="flex min-h-12 flex-1 items-center justify-center rounded-lg bg-accent text-base font-medium text-accent-contrast hover:bg-accent-strong disabled:opacity-40"
          >
            Next →
          </button>
        </footer>
      )}
    </div>
  );
}

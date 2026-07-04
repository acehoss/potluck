'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { newClientKey } from '@/lib/client-key';
import { useTRPC } from '@/lib/trpc';

/**
 * Meal planner (REWORK H1). A mobile-first vertical week: one card per day, meal
 * sections rendered only when they hold entries, one "+ Add" affordance per day.
 * Everything runs through trpc.plan.week; every mutation invalidates it. addEntry
 * carries a clientKey (one per sheet open) so a double-tap plans one entry.
 */

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
type Meal = (typeof MEALS)[number];
const MEAL_LABEL: Record<Meal, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

type PlanEntry = {
  id: string;
  meal: string;
  position: number;
  kind: string;
  recipeId: string | null;
  recipeTitle: string | null;
  servings: number | null;
  servingsOverride: number | null;
  text: string | null;
};
type WeekRecipe = { id: string; title: string; servings: number | null };

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';
const stepperBtn =
  'flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken disabled:opacity-40';

/** Local YYYY-MM-DD for a Date (calendar day, no TZ drift). */
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}
/** Parse a YYYY-MM-DD back into a local Date (midnight local). */
function parseYmd(s: string) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDaysStr(s: string, n: number) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
/** The Monday on or before `d` (week starts Monday). */
function mondayOf(d: Date) {
  const copy = new Date(d);
  const back = (copy.getDay() + 6) % 7; // days since Monday (Sun=0 → 6)
  copy.setDate(copy.getDate() - back);
  copy.setHours(0, 0, 0, 0);
  return copy;
}
function dayHeading(s: string) {
  return parseYmd(s).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
function rangeLabel(start: string) {
  const a = parseYmd(start);
  const b = parseYmd(addDaysStr(start, 6));
  const fmt = (d: Date, withMonth: boolean) =>
    d.toLocaleDateString(undefined, withMonth ? { month: 'short', day: 'numeric' } : { day: 'numeric' });
  const sameMonth = a.getMonth() === b.getMonth();
  return `${fmt(a, true)} – ${fmt(b, !sameMonth)}`;
}

export function PlanView() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const todayYmd = useMemo(() => ymd(new Date()), []);
  const [weekStart, setWeekStart] = useState(() => ymd(mondayOf(new Date())));
  const [addFor, setAddFor] = useState<string | null>(null); // a day's date
  const [editEntry, setEditEntry] = useState<PlanEntry | null>(null);

  const week = useQuery(trpc.plan.week.queryOptions({ start: weekStart }));
  const invalidate = () => queryClient.invalidateQueries(trpc.plan.week.pathFilter());

  const days = (week.data?.days ?? []) as { date: string; meals: Record<string, PlanEntry[]> }[];
  const recipes = (week.data?.recipes ?? []) as WeekRecipe[];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Link href="/" aria-label="Back to home" className="shrink-0 text-lg text-text-muted">
            ←
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
            Meal plan
          </h1>
          <Link
            href="/shopping"
            data-testid="shopping-link"
            className="shrink-0 text-sm font-medium text-accent-strong"
          >
            Shopping list →
          </Link>
        </div>
        <div className="flex items-center justify-between gap-2 pl-8">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="plan-week-prev"
              aria-label="Previous week"
              onClick={() => setWeekStart((s) => addDaysStr(s, -7))}
              className="flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg text-text hover:bg-surface-sunken"
            >
              ←
            </button>
            <span className="min-w-28 text-center text-sm font-medium text-text tabular-nums">
              {rangeLabel(weekStart)}
            </span>
            <button
              type="button"
              data-testid="plan-week-next"
              aria-label="Next week"
              onClick={() => setWeekStart((s) => addDaysStr(s, 7))}
              className="flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg text-text hover:bg-surface-sunken"
            >
              →
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        {days.map((day) => {
          const isToday = day.date === todayYmd;
          const filledMeals = MEALS.filter((m) => (day.meals[m]?.length ?? 0) > 0);
          return (
            <section
              key={day.date}
              data-testid="plan-day"
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
            >
              <div className="flex items-center gap-2">
                <h2
                  className={`text-sm font-semibold ${isToday ? 'text-accent-strong' : 'text-text'}`}
                >
                  {dayHeading(day.date)}
                </h2>
                {isToday && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-strong">
                    Today
                  </span>
                )}
              </div>

              {filledMeals.map((meal) => (
                <div key={meal} className="flex flex-col gap-1.5">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
                    {MEAL_LABEL[meal]}
                  </h3>
                  <div className="flex flex-col gap-1.5">
                    {day.meals[meal].map((entry) => (
                      <EntryRow key={entry.id} entry={entry} onEdit={setEditEntry} />
                    ))}
                  </div>
                </div>
              ))}

              <button
                type="button"
                data-testid="plan-add"
                onClick={() => setAddFor(day.date)}
                className="min-h-11 self-start rounded-lg border border-dashed border-border-strong px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-surface-sunken"
              >
                + Add
              </button>
            </section>
          );
        })}
      </div>

      {addFor && (
        <AddSheet
          date={addFor}
          recipes={recipes}
          onClose={() => setAddFor(null)}
          onDone={() => {
            setAddFor(null);
            invalidate();
          }}
        />
      )}

      {editEntry && (
        <EditSheet
          entry={editEntry}
          onClose={() => setEditEntry(null)}
          onDone={() => {
            setEditEntry(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

/** One planned entry, tappable to open its edit sheet. */
function EntryRow({ entry, onEdit }: { entry: PlanEntry; onEdit: (e: PlanEntry) => void }) {
  const deletedRecipe = entry.kind === 'recipe' && entry.recipeId === null;
  return (
    <button
      type="button"
      data-testid="plan-entry"
      onClick={() => onEdit(entry)}
      className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-sunken"
    >
      {entry.kind === 'recipe' &&
        (deletedRecipe ? (
          <span className="italic text-text-muted">(deleted recipe)</span>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            {entry.recipeTitle}
            {entry.servingsOverride != null && (
              <span className="text-text-muted"> ×{entry.servings} servings</span>
            )}
          </span>
        ))}
      {entry.kind === 'item' && <span className="min-w-0 flex-1 truncate">{entry.text}</span>}
      {entry.kind === 'note' && (
        <span className="min-w-0 flex-1 truncate italic text-text-muted">{entry.text}</span>
      )}
    </button>
  );
}

/** Add a plannable to one day: Recipe / Item / Note, with a meal select. */
function AddSheet({
  date,
  recipes,
  onClose,
  onDone,
}: {
  date: string;
  recipes: WeekRecipe[];
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const [clientKey] = useState(newClientKey);
  const [meal, setMeal] = useState<Meal>('dinner');
  const [kind, setKind] = useState<'recipe' | 'item' | 'note'>('recipe');
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [servings, setServings] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selectedRecipe = recipes.find((r) => r.id === recipeId) ?? null;
  const filtered = recipes.filter((r) => r.title.toLowerCase().includes(search.trim().toLowerCase()));

  const add = useMutation(
    trpc.plan.addEntry.mutationOptions({ onSuccess: onDone, onError: (e) => setError(e.message) }),
  );

  const pickRecipe = (r: WeekRecipe) => {
    setRecipeId(r.id);
    setServings(r.servings ?? null);
    setError(null);
  };

  const kindBtn = (active: boolean) =>
    `min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      active
        ? 'bg-accent text-accent-contrast'
        : 'border border-border-strong text-text hover:bg-surface-sunken'
    }`;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (kind === 'recipe') {
      if (!recipeId) {
        setError('Pick a recipe to plan.');
        return;
      }
      const override =
        selectedRecipe && servings != null && servings !== selectedRecipe.servings
          ? servings
          : undefined;
      add.mutate({ date, meal, kind: 'recipe', recipeId, servingsOverride: override, clientKey });
    } else {
      if (!text.trim()) {
        setError('Enter some text.');
        return;
      }
      add.mutate({ date, meal, kind, text: text.trim(), clientKey });
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="plan-add-sheet"
        onSubmit={submit}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="text-lg font-semibold">Add to {dayHeading(date)}</h2>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Meal
          <select
            data-testid="plan-add-meal"
            value={meal}
            onChange={(e) => setMeal(e.target.value as Meal)}
            className={inputClass}
          >
            {MEALS.map((m) => (
              <option key={m} value={m}>
                {MEAL_LABEL[m]}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-2" role="radiogroup" aria-label="What to add">
          {(['recipe', 'item', 'note'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              data-testid={`plan-add-kind-${k}`}
              onClick={() => {
                setKind(k);
                setError(null);
              }}
              className={kindBtn(kind === k)}
            >
              {k === 'recipe' ? 'Recipe' : k === 'item' ? 'Item' : 'Note'}
            </button>
          ))}
        </div>

        {kind === 'recipe' ? (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search your book…"
              aria-label="Search recipes"
              className={inputClass}
            />
            <div
              data-testid="plan-entry-recipe-picker"
              className="flex max-h-52 flex-col gap-1 overflow-y-auto"
            >
              {filtered.length === 0 && (
                <p className="px-1 py-2 text-sm text-text-muted">
                  {recipes.length === 0
                    ? 'Your book is empty — add a recipe first, or plan an item instead.'
                    : 'No recipes match.'}
                </p>
              )}
              {filtered.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => pickRecipe(r)}
                  className={`flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    recipeId === r.id
                      ? 'border-accent bg-accent-soft text-accent-strong'
                      : 'border-border text-text hover:bg-surface-sunken'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  {r.servings != null && (
                    <span className="shrink-0 text-xs text-text-muted">{r.servings} servings</span>
                  )}
                </button>
              ))}
            </div>

            {selectedRecipe && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-text">Servings</span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    aria-label="Fewer servings"
                    disabled={(servings ?? 1) <= 1}
                    onClick={() => setServings((s) => Math.max(1, (s ?? 1) - 1))}
                    className={stepperBtn}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={999}
                    data-testid="plan-entry-servings"
                    aria-label="Servings"
                    value={servings ?? ''}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setServings(Number.isInteger(n) && n >= 1 ? Math.min(n, 999) : null);
                    }}
                    className={`${inputClass} w-20 text-center font-mono tabular-nums`}
                  />
                  <button
                    type="button"
                    aria-label="More servings"
                    onClick={() => setServings((s) => Math.min(999, (s ?? 0) + 1))}
                    className={stepperBtn}
                  >
                    +
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            {kind === 'item' ? 'Item' : 'Note'}
            <input
              type="text"
              data-testid="plan-add-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={kind === 'item' ? 'A dozen eggs' : 'Marie hosts — keep it light'}
              className={inputClass}
            />
          </label>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button
            type="submit"
            data-testid="plan-add-submit"
            disabled={add.isPending}
            className={primaryBtn}
          >
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Edit one entry: move meal/day, rescale a recipe, or remove it. */
function EditSheet({
  entry,
  onClose,
  onDone,
}: {
  entry: PlanEntry;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const [meal, setMeal] = useState<Meal>(entry.meal as Meal);
  const [date, setDate] = useState(''); // filled by the caller's day; see below
  const [servings, setServings] = useState<number | null>(entry.servings);
  const [error, setError] = useState<string | null>(null);
  const isRecipe = entry.kind === 'recipe' && entry.recipeId !== null;

  const onError = (e: { message: string }) => setError(e.message);
  const update = useMutation(trpc.plan.updateEntry.mutationOptions({ onSuccess: onDone, onError }));
  const remove = useMutation(trpc.plan.removeEntry.mutationOptions({ onSuccess: onDone, onError }));

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    update.mutate({
      entryId: entry.id,
      meal,
      // Only send date when the user picked one (empty = leave it).
      date: date || undefined,
      servingsOverride: isRecipe && servings != null ? servings : undefined,
    });
  }

  const title =
    entry.kind === 'recipe'
      ? entry.recipeId
        ? entry.recipeTitle
        : '(deleted recipe)'
      : entry.text;

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="plan-entry-sheet"
        onSubmit={save}
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="truncate text-lg font-semibold">{title}</h2>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Meal
          <select
            data-testid="plan-entry-meal"
            value={meal}
            onChange={(e) => setMeal(e.target.value as Meal)}
            className={inputClass}
          >
            {MEALS.map((m) => (
              <option key={m} value={m}>
                {MEAL_LABEL[m]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Move to day
          <input
            type="date"
            data-testid="plan-entry-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputClass}
          />
        </label>

        {isRecipe && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-text">Servings</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Fewer servings"
                disabled={(servings ?? 1) <= 1}
                onClick={() => setServings((s) => Math.max(1, (s ?? 1) - 1))}
                className={stepperBtn}
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={999}
                data-testid="plan-entry-edit-servings"
                aria-label="Servings"
                value={servings ?? ''}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setServings(Number.isInteger(n) && n >= 1 ? Math.min(n, 999) : null);
                }}
                className={`${inputClass} w-20 text-center font-mono tabular-nums`}
              />
              <button
                type="button"
                aria-label="More servings"
                onClick={() => setServings((s) => Math.min(999, (s ?? 0) + 1))}
                className={stepperBtn}
              >
                +
              </button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            data-testid="plan-entry-remove"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ entryId: entry.id })}
            className="min-h-11 rounded-lg border border-danger/40 px-4 py-2.5 font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
          >
            Remove
          </button>
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button
            type="submit"
            data-testid="plan-entry-save"
            disabled={update.isPending}
            className={primaryBtn}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

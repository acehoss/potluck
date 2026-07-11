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
  addedToShoppingAt: string | null;
};
type WeekRecipe = { id: string; title: string; servings: number | null };
type OutgoingOrder = {
  id: string;
  status: string;
  pantryName: string;
  ownerHouseholdName: string;
  lineCount: number;
};
type MyPost = { id: string; type: string; title: string; status: string };

const ORDER_STATUS: Record<string, string> = {
  REQUESTED: 'Requested',
  PICKING: 'Being picked',
  READY: 'Ready — go pick up',
};

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

export function PlanView({
  outgoingOrders,
  myPosts,
}: {
  outgoingOrders: OutgoingOrder[];
  myPosts: MyPost[];
}) {
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
        <div className="flex items-center justify-between gap-2">
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

      {outgoingOrders.length > 0 && (
        <section data-testid="plan-outgoing-orders" className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Your orders
          </h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm">
            {outgoingOrders.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/orders/${o.id}`}
                  data-testid="plan-order-row"
                  className="flex min-h-14 items-center justify-between gap-3 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text">
                      {o.ownerHouseholdName} · {o.pantryName}
                    </span>
                    <span className="block text-xs text-text-muted">
                      {o.lineCount} {o.lineCount === 1 ? 'item' : 'items'}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
                    {ORDER_STATUS[o.status] ?? o.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {myPosts.length > 0 && (
        <section data-testid="plan-my-posts" className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Your posts
          </h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm">
            {myPosts.map((p) => (
              <li key={p.id}>
                <Link
                  href="/shares"
                  data-testid="plan-post-row"
                  className="flex min-h-14 items-center justify-between gap-3 py-2.5"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden>{p.type === 'SURPLUS' ? '🥘' : '🙋'}</span>
                    <span className="truncate text-sm text-text">{p.title}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
                    {p.status.toLowerCase()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

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
          recipes={recipes}
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
      {entry.kind === 'recipe' && !deletedRecipe && entry.addedToShoppingAt && (
        <span
          data-testid="plan-entry-in-list"
          title="On the shopping list"
          aria-label="On the shopping list"
          className="shrink-0 text-xs text-success"
        >
          🛒✓
        </span>
      )}
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
  const [selected, setSelected] = useState<{
    source: 'own' | 'shared';
    id: string;
    baseServings: number | null;
  } | null>(null);
  const [servings, setServings] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Own book comes from plan.week (the `recipes` prop). Connections' shared books
  // come from recipe.list — picking one FORKS a copy into your book first (plan
  // entries are always own-book, Priya's in-calendar picker rule).
  const recipeList = useQuery(trpc.recipe.list.queryOptions());
  const q = search.trim().toLowerCase();
  const filtered = recipes.filter((r) => r.title.toLowerCase().includes(q));
  const shared = (recipeList.data?.shared ?? []).filter((r) => r.title.toLowerCase().includes(q));

  const add = useMutation(
    trpc.plan.addEntry.mutationOptions({ onSuccess: onDone, onError: (e) => setError(e.message) }),
  );
  const fork = useMutation(trpc.recipe.fork.mutationOptions());
  const busy = add.isPending || fork.isPending;

  const pickOwn = (r: WeekRecipe) => {
    setSelected({ source: 'own', id: r.id, baseServings: r.servings ?? null });
    setServings(r.servings ?? null);
    setError(null);
  };
  const pickShared = (r: { id: string; servings: number | null }) => {
    setSelected({ source: 'shared', id: r.id, baseServings: r.servings ?? null });
    setServings(r.servings ?? null);
    setError(null);
  };

  const kindBtn = (active: boolean) =>
    `min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      active
        ? 'bg-accent text-accent-contrast'
        : 'border border-border-strong text-text hover:bg-surface-sunken'
    }`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (kind === 'recipe') {
      if (!selected) {
        setError('Pick a recipe to plan.');
        return;
      }
      const override =
        selected.baseServings != null && servings != null && servings !== selected.baseServings
          ? servings
          : undefined;
      let recipeId = selected.id;
      // A connection's recipe is forked into our book first, then planned.
      if (selected.source === 'shared') {
        try {
          const forked = await fork.mutateAsync({ recipeId: selected.id, clientKey: `${clientKey}-fork` });
          recipeId = forked.id;
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not save that recipe to your book.');
          return;
        }
      }
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
              placeholder="Search recipes…"
              aria-label="Search recipes"
              className={inputClass}
            />
            <div
              data-testid="plan-entry-recipe-picker"
              className="flex max-h-52 flex-col gap-1 overflow-y-auto"
            >
              {filtered.length === 0 && shared.length === 0 && (
                <p className="px-1 py-2 text-sm text-text-muted">
                  {recipes.length === 0 && shared.length === 0
                    ? 'No recipes yet — add one to your book, or plan an item instead.'
                    : 'No recipes match.'}
                </p>
              )}
              {filtered.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => pickOwn(r)}
                  className={`flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    selected?.source === 'own' && selected.id === r.id
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

              {shared.length > 0 && (
                <div data-testid="plan-picker-shared" className="flex flex-col gap-1">
                  <p className="px-1 pt-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                    From your connections — saves a copy to your book
                  </p>
                  {shared.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      data-testid="plan-shared-recipe"
                      onClick={() => pickShared(r)}
                      className={`flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        selected?.source === 'shared' && selected.id === r.id
                          ? 'border-accent bg-accent-soft text-accent-strong'
                          : 'border-border text-text hover:bg-surface-sunken'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{r.title}</span>
                      <span className="shrink-0 text-xs text-text-muted">{r.householdName}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selected && (
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
            disabled={busy}
            className={primaryBtn}
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Edit one entry: replace its content, move meal/day, or remove it. */
function EditSheet({
  entry,
  recipes,
  onClose,
  onDone,
}: {
  entry: PlanEntry;
  recipes: WeekRecipe[];
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [meal, setMeal] = useState<Meal>(entry.meal as Meal);
  const [date, setDate] = useState(''); // empty leaves the existing day unchanged
  const [recipeId, setRecipeId] = useState(entry.recipeId ?? '');
  const [servings, setServings] = useState<number | null>(entry.servings);
  const [entryText, setEntryText] = useState(entry.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const isRecipe = entry.kind === 'recipe';
  const selectedRecipe = recipes.find((recipe) => recipe.id === recipeId);

  // "Add to shopping list" (per-entry). Independent of Save/Remove: it keeps the
  // sheet open, shows an inline count, and re-invalidates the week so the row's
  // 🛒✓ indicator appears. Re-adding is safe (server merges by name+unit).
  const [listKey, setListKey] = useState(newClientKey);
  const [listMsg, setListMsg] = useState<string | null>(null);
  const [addedOnce, setAddedOnce] = useState(entry.addedToShoppingAt != null);

  const onError = (e: { message: string }) => setError(e.message);
  const update = useMutation(trpc.plan.updateEntry.mutationOptions({ onSuccess: onDone, onError }));
  const remove = useMutation(trpc.plan.removeEntry.mutationOptions({ onSuccess: onDone, onError }));
  const addToList = useMutation(
    trpc.shopping.addFromEntry.mutationOptions({
      onSuccess: (res) => {
        setListMsg(`Added ${res.added + res.updated} items`);
        setError(null);
        setAddedOnce(true);
        setListKey(newClientKey());
        queryClient.invalidateQueries(trpc.plan.week.pathFilter());
      },
      onError,
    }),
  );

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isRecipe && !entryText.trim()) {
      setError('Enter some text.');
      return;
    }
    update.mutate({
      entryId: entry.id,
      meal,
      // Only send date when the user picked one (empty = leave it).
      date: date || undefined,
      recipeId: isRecipe && recipeId ? recipeId : undefined,
      servingsOverride: isRecipe
        ? servings != null && servings !== selectedRecipe?.servings
          ? servings
          : null
        : undefined,
      text: isRecipe ? undefined : entryText.trim(),
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
        <h2 className="truncate text-lg font-semibold">Edit {title}</h2>

        {isRecipe && entry.recipeId && (
          <Link
            href={`/recipes/${entry.recipeId}`}
            data-testid="plan-entry-view-recipe"
            className="text-sm font-medium text-accent underline"
          >
            View recipe →
          </Link>
        )}

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

        {isRecipe ? (
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            Recipe
            <select
              data-testid="plan-entry-recipe"
              value={recipeId}
              onChange={(e) => {
                const nextId = e.target.value;
                const next = recipes.find((recipe) => recipe.id === nextId);
                setRecipeId(nextId);
                setServings(next?.servings ?? null);
                setError(null);
              }}
              className={inputClass}
            >
              {!recipeId && <option value="">Pick a recipe…</option>}
              {recipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            {entry.kind === 'item' ? 'Item' : 'Note'}
            <input
              type="text"
              data-testid="plan-entry-text"
              value={entryText}
              maxLength={300}
              onChange={(e) => setEntryText(e.target.value)}
              className={inputClass}
            />
          </label>
        )}

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

        {isRecipe && recipeId && (
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

        {isRecipe && entry.recipeId && (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              data-testid="plan-entry-add-to-list"
              disabled={addToList.isPending}
              onClick={() => addToList.mutate({ planEntryId: entry.id, clientKey: listKey })}
              className="min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
            >
              {addToList.isPending
                ? 'Adding…'
                : addedOnce
                  ? 'Add to shopping list again'
                  : 'Add to shopping list'}
            </button>
            {listMsg && (
              <p role="status" className="text-sm font-medium text-success">
                {listMsg}
              </p>
            )}
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

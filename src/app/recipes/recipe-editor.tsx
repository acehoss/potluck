'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { BackLink } from '@/app/nav-history';
import { newClientKey } from '@/lib/client-key';
import { downscaleToJpeg, uploadImage } from '@/lib/downscale';
import { useTRPC } from '@/lib/trpc';
import { IngredientLinkControl } from './ingredient-link-control';
import type { IngredientLink, RecipeDto } from './types';
import { inputClass, primaryBtn, secondaryBtn } from './ui';

/**
 * The recipe editor — the app's biggest form (G1). Used for both create (no
 * `initial`) and edit (own recipe passed in). Ingredient lines are structured
 * item/heading rows kept in array order; paste-to-parse and URL import are
 * review-first assists that fill the rows. One clientKey per create submission
 * (idempotency); update/delete carry none (the server keys those by identity).
 */

type Row = {
  key: string;
  kind: 'item' | 'heading';
  amount: string;
  unit: string;
  text: string;
  note: string;
  link: IngredientLink | null;
};

function emptyItem(): Row {
  return { key: newClientKey(), kind: 'item', amount: '', unit: '', text: '', note: '', link: null };
}

function seedRows(initial?: RecipeDto): Row[] {
  if (!initial || initial.ingredients.length === 0) return [emptyItem(), emptyItem()];
  return initial.ingredients.map((i) => ({
    key: i.id,
    kind: i.kind,
    amount: i.amount ?? '',
    unit: i.unit ?? '',
    text: i.text,
    note: i.note ?? '',
    link: i.link,
  }));
}

/** Parse a non-negative integer field, or undefined when blank/invalid. */
function intField(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function RecipeEditor({
  initial,
  backFallback = '/recipes',
}: {
  initial?: RecipeDto;
  backFallback?: string;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [clientKey] = useState(newClientKey);

  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [servings, setServings] = useState(initial?.servings != null ? String(initial.servings) : '');
  const [yieldText, setYieldText] = useState(initial?.yieldText ?? '');
  const [prep, setPrep] = useState(initial?.prepMinutes != null ? String(initial.prepMinutes) : '');
  const [cook, setCook] = useState(initial?.cookMinutes != null ? String(initial.cookMinutes) : '');
  const [course, setCourse] = useState(initial?.course ?? '');
  const [cuisine, setCuisine] = useState(initial?.cuisine ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [directions, setDirections] = useState(initial?.directions ?? '');
  const [sourceUrl, setSourceUrl] = useState(initial?.sourceUrl ?? '');
  const [isPrivate, setPrivate] = useState(initial?.private ?? false);
  const [rows, setRows] = useState<Row[]>(() => seedRows(initial));

  // Photo: keep the existing path unless removed or replaced by a fresh upload.
  const existingPhoto = initial?.photoPath ?? null;
  const [newPhoto, setNewPhoto] = useState<{ path: string; preview: string } | null>(null);
  const [removed, setRemoved] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Set when a URL import found a photo but couldn't download it as a JPEG.
  const [importPhotoNote, setImportPhotoNote] = useState<string | null>(null);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Invalidate the list AND every per-id read view — Round R's read page holds
  // recipe.get with a staleTime, so a soft-nav back after editing would show
  // stale content for up to 30s otherwise.
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.recipe.list.pathFilter());
    void queryClient.invalidateQueries(trpc.recipe.get.pathFilter());
  };
  const onError = (e: { message: string }) => setError(e.message);

  const create = useMutation(
    trpc.recipe.create.mutationOptions({
      onSuccess: () => {
        invalidate();
        router.push('/recipes');
      },
      onError,
    }),
  );
  const update = useMutation(
    trpc.recipe.update.mutationOptions({
      onSuccess: () => {
        invalidate();
        router.push('/recipes');
      },
      onError,
    }),
  );
  const del = useMutation(
    trpc.recipe.delete.mutationOptions({
      onSuccess: () => {
        invalidate();
        router.push('/recipes');
      },
      onError,
    }),
  );
  const parse = useMutation(
    trpc.recipe.parseText.mutationOptions({
      onSuccess: (res) => {
        setRows((prev) => [
          ...prev,
          ...res.ingredients.map((pi) => ({
            key: newClientKey(),
            kind: pi.kind,
            amount: pi.amount ?? '',
            unit: pi.unit ?? '',
            text: pi.text,
            note: pi.note ?? '',
            link: null,
          })),
        ]);
        if (res.directions && !directions.trim()) setDirections(res.directions);
        setPasteOpen(false);
        setPasteText('');
      },
      onError,
    }),
  );
  const importMut = useMutation(
    trpc.recipe.importUrl.mutationOptions({
      onSuccess: (res) => {
        if (res.status === 'unavailable') {
          setImportMsg(res.reason);
          return;
        }
        const d = res.data;
        setImportMsg(null);
        if (d.title) setTitle(d.title);
        if (d.description) setDescription(d.description);
        if (d.directions) setDirections(d.directions);
        if (d.servings != null) setServings(String(d.servings));
        if (d.yieldText) setYieldText(d.yieldText);
        if (d.prepMinutes != null) setPrep(String(d.prepMinutes));
        if (d.cookMinutes != null) setCook(String(d.cookMinutes));
        setSourceUrl(d.sourceUrl);
        // Photo: the server downloaded + stored it (photoPath) when the site's
        // image came back as a JPEG; if it found one it couldn't fetch
        // (photoUrl set, photoPath null) we nudge the cook to add their own.
        if (d.photoPath) {
          if (newPhoto) URL.revokeObjectURL(newPhoto.preview);
          setNewPhoto({ path: d.photoPath, preview: `/api/images/${d.photoPath}` });
          setRemoved(false);
          setImportPhotoNote(null);
        } else {
          setImportPhotoNote(d.photoUrl ? "Couldn't fetch the site's photo — add one?" : null);
        }
        setRows(
          d.ingredients.length
            ? d.ingredients.map((pi) => ({
                key: newClientKey(),
                kind: pi.kind,
                amount: pi.amount ?? '',
                unit: pi.unit ?? '',
                text: pi.text,
                note: pi.note ?? '',
                link: null,
              }))
            : [emptyItem()],
        );
      },
      onError: (e) => setImportMsg(e.message),
    }),
  );

  const busy = create.isPending || update.isPending || del.isPending;

  function patchRow(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }
  function moveRow(key: string, dir: -1 | 1) {
    setRows((prev) => {
      const i = prev.findIndex((r) => r.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const jpeg = await downscaleToJpeg(file);
      const { path } = await uploadImage('recipes', jpeg);
      if (newPhoto) URL.revokeObjectURL(newPhoto.preview);
      setNewPhoto({ path, preview: URL.createObjectURL(jpeg) });
      setRemoved(false);
      setImportPhotoNote(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('A title is required.');
      return;
    }
    const ingredients = rows
      .map((r) => ({
        kind: r.kind,
        text: r.text.trim(),
        amount: r.kind === 'item' && r.amount.trim() ? r.amount.trim() : undefined,
        unit: r.kind === 'item' && r.unit.trim() ? r.unit.trim() : undefined,
        note: r.kind === 'item' && r.note.trim() ? r.note.trim() : undefined,
      }))
      .filter((r) => r.text.length > 0);

    const servingsNum = intField(servings);
    const body = {
      title: title.trim(),
      description: description.trim() || undefined,
      directions: directions.trim() || undefined,
      prepMinutes: intField(prep),
      cookMinutes: intField(cook),
      servings: servingsNum && servingsNum >= 1 ? servingsNum : undefined,
      yieldText: yieldText.trim() || undefined,
      course: course.trim() || undefined,
      cuisine: cuisine.trim() || undefined,
      tags: tags.trim() || undefined,
      sourceUrl: sourceUrl.trim() || undefined,
      private: isPrivate,
      ingredients,
    };

    if (initial) {
      const photoPath = newPhoto ? newPhoto.path : removed ? null : undefined;
      update.mutate({ recipeId: initial.id, ...body, photoPath });
    } else {
      create.mutate({ ...body, photoPath: newPhoto?.path, clientKey });
    }
  }

  const photoSrc = newPhoto?.preview ?? (!removed && existingPhoto ? `/api/images/${existingPhoto}` : null);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center gap-3">
        <BackLink fallback={backFallback} label="Back" />
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
          {initial ? 'Edit recipe' : 'New recipe'}
        </h1>
      </header>

      {initial?.forkedFromTitle && initial.forkedFromHouseholdName && (
        <p className="text-sm text-text-muted">
          Forked from {initial.forkedFromTitle} · {initial.forkedFromHouseholdName}
        </p>
      )}

      <form className="flex flex-col gap-5" onSubmit={submit}>
        {/* Import from URL — advisory, never blocks manual entry. */}
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-raised p-3 shadow-sm">
          <label className="text-sm font-medium text-text" htmlFor="recipe-import-url">
            Import from a recipe URL
          </label>
          <div className="flex gap-2">
            <input
              id="recipe-import-url"
              type="url"
              inputMode="url"
              data-testid="recipe-import-url"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://…"
              className={`${inputClass} min-w-0 flex-1`}
            />
            <button
              type="button"
              data-testid="recipe-import-fetch"
              disabled={importMut.isPending || !importUrl.trim()}
              onClick={() => {
                setImportMsg(null);
                importMut.mutate({ url: importUrl.trim() });
              }}
              className={secondaryBtn}
            >
              {importMut.isPending ? 'Fetching…' : 'Fetch'}
            </button>
          </div>
          {importMsg && (
            <p role="alert" className="text-sm text-warn">
              {importMsg}
            </p>
          )}
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Title
          <input
            type="text"
            required
            data-testid="recipe-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Grandma's cornbread"
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Description (optional)
          <textarea
            data-testid="recipe-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className={`${inputClass} resize-none`}
          />
        </label>

        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-text">
            Servings
            <input
              type="number"
              inputMode="numeric"
              min={1}
              data-testid="recipe-servings"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
              className={`${inputClass} w-full min-w-0`}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-text">
            Yield (optional)
            <input
              type="text"
              data-testid="recipe-yield"
              value={yieldText}
              onChange={(e) => setYieldText(e.target.value)}
              placeholder="1 loaf"
              className={`${inputClass} w-full min-w-0`}
            />
          </label>
        </div>

        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-text">
            Prep (min)
            <input
              type="number"
              inputMode="numeric"
              min={0}
              data-testid="recipe-prep"
              value={prep}
              onChange={(e) => setPrep(e.target.value)}
              className={`${inputClass} w-full min-w-0`}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-text">
            Cook (min)
            <input
              type="number"
              inputMode="numeric"
              min={0}
              data-testid="recipe-cook"
              value={cook}
              onChange={(e) => setCook(e.target.value)}
              className={`${inputClass} w-full min-w-0`}
            />
          </label>
        </div>

        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-text">
            Course (optional)
            <input
              type="text"
              data-testid="recipe-course"
              value={course}
              onChange={(e) => setCourse(e.target.value)}
              placeholder="Dinner"
              className={`${inputClass} w-full min-w-0`}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-text">
            Cuisine (optional)
            <input
              type="text"
              data-testid="recipe-cuisine"
              value={cuisine}
              onChange={(e) => setCuisine(e.target.value)}
              placeholder="Southern"
              className={`${inputClass} w-full min-w-0`}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Tags (comma-separated, optional)
          <input
            type="text"
            data-testid="recipe-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="comfort, potluck"
            className={inputClass}
          />
        </label>

        {/* Photo */}
        <div className="flex items-center gap-3">
          {photoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoSrc}
              alt=""
              data-testid="recipe-photo-preview"
              className="size-16 shrink-0 rounded-lg border border-border object-cover"
            />
          ) : (
            <span className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-muted">
              🍲
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            data-testid="recipe-photo-input"
            onChange={(e) => handleFile(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : photoSrc ? 'Replace photo' : 'Photo (optional)'}
          </button>
          {photoSrc && (
            <button
              type="button"
              onClick={() => {
                if (newPhoto) URL.revokeObjectURL(newPhoto.preview);
                setNewPhoto(null);
                setRemoved(true);
                setImportPhotoNote(null);
              }}
              className="min-h-11 rounded-lg px-2 py-2 text-sm font-medium text-text-muted hover:text-danger"
            >
              Remove
            </button>
          )}
        </div>

        {importPhotoNote && (
          <p data-testid="recipe-import-photo-note" className="-mt-3 text-sm text-text-muted">
            {importPhotoNote}
          </p>
        )}

        {/* Ingredients */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-text">Ingredients</h2>
          </div>

          <ul className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <li
                key={row.key}
                data-testid="recipe-ingredient-row"
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-2"
              >
                {row.kind === 'heading' ? (
                  <input
                    type="text"
                    aria-label="Section heading"
                    value={row.text}
                    onChange={(e) => patchRow(row.key, { text: e.target.value })}
                    placeholder="Section (e.g. For the sauce)"
                    className={`${inputClass} font-semibold uppercase tracking-wide`}
                  />
                ) : (
                  <div className="grid grid-cols-[4rem_4rem_1fr] gap-2">
                    <input
                      type="text"
                      aria-label="Amount"
                      value={row.amount}
                      onChange={(e) => patchRow(row.key, { amount: e.target.value })}
                      placeholder="1"
                      className={`${inputClass} px-2 text-center`}
                    />
                    <input
                      type="text"
                      aria-label="Unit"
                      value={row.unit}
                      onChange={(e) => patchRow(row.key, { unit: e.target.value })}
                      placeholder="cup"
                      className={`${inputClass} px-2`}
                    />
                    <input
                      type="text"
                      aria-label="Ingredient"
                      value={row.text}
                      onChange={(e) => patchRow(row.key, { text: e.target.value })}
                      placeholder="flour"
                      className={`${inputClass} min-w-0`}
                    />
                  </div>
                )}
                {row.kind === 'item' && (
                  <input
                    type="text"
                    aria-label="Note"
                    value={row.note}
                    onChange={(e) => patchRow(row.key, { note: e.target.value })}
                    placeholder="Note (optional) — e.g. sifted"
                    className={`${inputClass} text-sm`}
                  />
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => moveRow(row.key, -1)}
                    className="min-h-11 rounded-lg border border-border-strong px-2.5 text-sm text-text-muted hover:bg-surface-sunken disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={i === rows.length - 1}
                    onClick={() => moveRow(row.key, 1)}
                    className="min-h-11 rounded-lg border border-border-strong px-2.5 text-sm text-text-muted hover:bg-surface-sunken disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label="Remove line"
                    onClick={() => removeRow(row.key)}
                    className="min-h-11 rounded-lg border border-border-strong px-2.5 text-sm text-text-muted hover:bg-surface-sunken hover:text-danger"
                  >
                    ✕
                  </button>
                  {row.kind === 'item' && row.text.trim() && (
                    <div className="ml-auto">
                      <IngredientLinkControl key={row.key} text={row.text} initialLink={row.link} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="recipe-add-line"
              onClick={() => setRows((prev) => [...prev, emptyItem()])}
              className={secondaryBtn}
            >
              + Ingredient
            </button>
            <button
              type="button"
              data-testid="recipe-add-heading"
              onClick={() =>
                setRows((prev) => [
                  ...prev,
                  { key: newClientKey(), kind: 'heading', amount: '', unit: '', text: '', note: '', link: null },
                ])
              }
              className={secondaryBtn}
            >
              + Section heading
            </button>
            <button
              type="button"
              data-testid="recipe-paste-open"
              onClick={() => setPasteOpen(true)}
              className={secondaryBtn}
            >
              Paste to parse
            </button>
          </div>
        </section>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Directions (optional)
          <textarea
            data-testid="recipe-directions"
            value={directions}
            onChange={(e) => setDirections(e.target.value)}
            rows={6}
            className={`${inputClass} resize-y`}
          />
        </label>

        {sourceUrl && (
          <p className="text-xs text-text-muted">
            Source:{' '}
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-accent underline">
              {sourceUrl}
            </a>
          </p>
        )}

        <label className="flex items-center gap-3 text-sm font-medium text-text">
          <input
            type="checkbox"
            data-testid="recipe-private"
            checked={isPrivate}
            onChange={(e) => setPrivate(e.target.checked)}
            className="size-5 accent-[var(--color-accent)]"
          />
          Keep private (not shown to your connections)
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button type="submit" data-testid="recipe-save" disabled={busy || uploading} className={`${primaryBtn} flex-1`}>
            {create.isPending || update.isPending ? 'Saving…' : 'Save recipe'}
          </button>
        </div>

        {initial && (
          <button
            type="button"
            data-testid="recipe-delete"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Delete this recipe? This cannot be undone.')) {
                setError(null);
                del.mutate({ recipeId: initial.id });
              }
            }}
            className="min-h-11 self-start rounded-lg border border-danger/40 px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
          >
            Delete recipe
          </button>
        )}
      </form>

      {pasteOpen && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
          <div className="flex w-full max-w-md flex-col gap-3 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl">
            <h2 className="text-lg font-semibold">Paste a recipe</h2>
            <p className="text-sm text-text-muted">
              Paste an ingredient list (and directions). We&apos;ll split it into lines you can
              review and edit — nothing is saved until you do.
            </p>
            <textarea
              data-testid="recipe-paste-text"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={8}
              placeholder={'2 cups flour\n1 tsp salt\n1 cup buttermilk'}
              className={`${inputClass} resize-y`}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPasteOpen(false)}
                className={`${secondaryBtn} flex-1`}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="recipe-paste-apply"
                disabled={parse.isPending || !pasteText.trim()}
                onClick={() => parse.mutate({ text: pasteText })}
                className={`${primaryBtn} flex-1`}
              >
                {parse.isPending ? 'Parsing…' : 'Add lines'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import { useRef, useState } from 'react';
import { downscaleToJpeg, uploadImage } from '@/lib/downscale';

export type GalleryImage = {
  id: string;
  path: string;
  position: number;
};

/**
 * Shared hero + thumb-strip gallery (media round) for products and items.
 * Position 0 is the main photo. Owners get add / set-main / remove;
 * cross-household viewers see the gallery read-only. The parent owns the
 * mutations (and refreshes on success); this component owns the file capture,
 * downscale+upload, and hero selection. (Per-photo preset labels shipped in
 * the media round and were dropped 2026-07-07 — the DB column is dormant.)
 */
export function MediaGallery({
  images,
  fallbackPath,
  alt,
  canEdit,
  uploadKind,
  testIdPrefix,
  placeholder,
  cap = 8,
  onAddImage,
  onSetMain,
  onRemove,
}: {
  images: GalleryImage[];
  /** Shown when there are no gallery images (derived lot/unit photo). */
  fallbackPath: string | null;
  alt: string;
  canEdit: boolean;
  uploadKind: 'products' | 'items';
  testIdPrefix: 'product' | 'item';
  placeholder: string;
  cap?: number;
  onAddImage: (path: string) => Promise<unknown>;
  onSetMain: (imageId: string) => Promise<unknown>;
  onRemove: (imageId: string) => Promise<unknown>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasImages = images.length > 0;
  const idx = hasImages ? Math.min(selected, images.length - 1) : 0;
  const current = hasImages ? images[idx] : null;
  const heroPath = current?.path ?? fallbackPath;
  const atCap = images.length >= cap;

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const jpeg = await downscaleToJpeg(file);
      const { path } = await uploadImage(uploadKind, jpeg);
      await onAddImage(path);
      // New image appends at the end; jump the hero to it.
      setSelected(images.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const actionBtn =
    'min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

  return (
    <div className="flex flex-col gap-3">
      {/* Hero */}
      {heroPath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          data-testid={`${testIdPrefix}-photo-hero`}
          src={`/api/images/${heroPath}`}
          alt={alt}
          className="aspect-square w-full rounded-xl border border-border object-cover"
        />
      ) : (
        <span
          data-testid={`${testIdPrefix}-photo-hero`}
          className="flex aspect-square w-full items-center justify-center rounded-xl bg-surface-sunken text-5xl text-text-muted"
        >
          {placeholder}
        </span>
      )}

      {/* Thumb strip */}
      {hasImages && (
        <ul className="flex flex-wrap gap-2">
          {images.map((image, i) => (
            <li key={image.id} className="relative">
              <button
                type="button"
                data-testid={`${testIdPrefix}-thumb-${i}`}
                aria-label={`Photo ${i + 1}`}
                aria-current={i === idx}
                onClick={() => setSelected(i)}
                className={`size-16 overflow-hidden rounded-lg border object-cover transition-colors ${
                  i === idx ? 'border-accent ring-2 ring-accent/30' : 'border-border'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/images/${image.path}`}
                  alt=""
                  className="size-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="flex flex-col gap-2">
          {/* Add — file input carries the testid; the button just triggers it. */}
          {/* No `capture` attr: on iOS that forces the camera and hides the
              photo-library option; without it the OS offers both. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            data-testid={`${testIdPrefix}-photo-add`}
            onChange={(e) => handleFile(e.target.files)}
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || atCap}
              className={actionBtn}
            >
              {uploading ? 'Uploading…' : 'Add photo'}
            </button>
            {atCap && (
              <span className="text-xs text-text-muted">Up to {cap} photos.</span>
            )}
          </div>

          {/* Per-photo actions act on the selected hero photo. */}
          {current && (
            <div className="flex flex-wrap items-center gap-2">
              {current.position !== 0 && (
                <button
                  type="button"
                  data-testid={`${testIdPrefix}-photo-set-main`}
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await onSetMain(current.id);
                      // The promoted photo becomes position 0 — follow it so the
                      // hero shows what the user just set as main.
                      setSelected(0);
                    })
                  }
                  className={actionBtn}
                >
                  Set as main
                </button>
              )}
              <button
                type="button"
                data-testid={`${testIdPrefix}-photo-remove`}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await onRemove(current.id);
                    setSelected(0);
                  })
                }
                className="min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-surface-sunken disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

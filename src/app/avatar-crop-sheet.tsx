'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadImage } from '@/lib/downscale';

/**
 * Avatar crop sheet (profile-polish round, D1). Opens after the profile photo
 * pick with a fixed CIRCLE viewport (the mask) over a pannable/zoomable image,
 * then crops the circle's bounding square to a 512×512 JPEG and hands the
 * uploaded `{ path, preview }` back to ProfileSheet — the exact shape its old
 * direct-upload path produced.
 *
 * Gestures are unified through Pointer Events (`touch-action: none` on the
 * stage so a drag never scrolls the sheet): one pointer pans, two pointers
 * pinch-zoom, the wheel zooms (desktop), and an always-visible range slider is
 * the accessibility fallback that works everywhere. The image is clamped to
 * always cover the circle — no gaps, ever — so zoom bottoms out at "cover" and
 * tops out at 5× cover.
 *
 * Zoom is tracked as a cover-relative FACTOR (1 = cover, up to 5×), which makes
 * the cover scale itself pure-derived (`stage / min(w,h)`) with no fit-effect
 * setState. No new deps: the crop is a single canvas `drawImage` from the
 * `createImageBitmap(file)` bitmap (orientation handled the same way
 * `downscale.ts` does, so preview and output agree pixel-for-pixel).
 */

const MAX_ZOOM = 5; // × the cover scale

type Offset = { x: number; y: number };

/** Clamp the image-center offset so the scaled image still covers the square stage. */
function clampOffset(offset: Offset, scale: number, imgW: number, imgH: number, stage: number): Offset {
  const maxX = Math.max(0, (imgW * scale - stage) / 2);
  const maxY = Math.max(0, (imgH * scale - stage) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

export function AvatarCropSheet({
  file,
  onCancel,
  onCropped,
}: {
  file: File;
  onCancel: () => void;
  onCropped: (result: { path: string; preview: string }) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [stageSize, setStageSize] = useState(0);
  const [zoom, setZoom] = useState(1); // cover-relative: 1 = cover, up to MAX_ZOOM
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const imgW = bitmap?.width ?? 0;
  const imgH = bitmap?.height ?? 0;
  const coverScale = bitmap && stageSize ? stageSize / Math.min(imgW, imgH) : 0;
  const scale = coverScale * zoom;

  // Live geometry for gesture handlers (avoids stale-closure math within a drag).
  // Written only from event handlers and effects, never during render.
  const geom = useRef({ zoom: 1, offset: { x: 0, y: 0 } as Offset });
  const dims = useRef({ imgW: 0, imgH: 0, stage: 0, cover: 0 });
  useEffect(() => {
    dims.current = { imgW, imgH, stage: stageSize, cover: coverScale };
  }, [imgW, imgH, stageSize, coverScale]);

  // Decode once; the natural-size canvas is drawn below and CSS-scaled.
  useEffect(() => {
    let live = true;
    let decoded: ImageBitmap | null = null;
    createImageBitmap(file)
      .then((bmp) => {
        if (!live) {
          bmp.close();
          return;
        }
        decoded = bmp;
        setBitmap(bmp);
      })
      .catch(() => live && setError('Could not read that image.'));
    return () => {
      live = false;
      decoded?.close();
    };
  }, [file]);

  // Measure the square stage in CSS px for the geometry math.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize(el.clientWidth));
    ro.observe(el);
    setStageSize(el.clientWidth);
    return () => ro.disconnect();
  }, [bitmap]);

  // Paint the bitmap into the display canvas at natural resolution (once).
  useEffect(() => {
    if (!bitmap) return;
    const canvas = canvasRef.current;
    if (canvas && (canvas.width !== bitmap.width || canvas.height !== bitmap.height)) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    }
  }, [bitmap]);

  /** Commit a new zoom/offset, clamped to the cover invariant, to state + the ref. */
  const apply = useCallback((nextZoom: number, nextOffset: Offset) => {
    const { imgW: w, imgH: h, stage, cover } = dims.current;
    if (!w || !stage || !cover) return;
    const z = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
    const o = clampOffset(nextOffset, cover * z, w, h, stage);
    geom.current = { zoom: z, offset: o };
    setZoom(z);
    setOffset(o);
  }, []);

  /** Zoom about a fixed stage-space point (cursor / pinch midpoint). */
  const zoomAbout = useCallback(
    (nextZoom: number, px: number, py: number) => {
      const { stage } = dims.current;
      const { zoom: z, offset: o } = geom.current;
      const clamped = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
      const ratio = clamped / z;
      const cx = stage / 2 + o.x;
      const cy = stage / 2 + o.y;
      const ncx = px - (px - cx) * ratio;
      const ncy = py - (py - cy) * ratio;
      apply(clamped, { x: ncx - stage / 2, y: ncy - stage / 2 });
    },
    [apply],
  );

  // Pointer bookkeeping: id → last stage-space position.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchPrev = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);

  const stagePoint = (e: React.PointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    try {
      stageRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Some environments (synthetic events) reject capture — panning still works.
    }
    pointers.current.set(e.pointerId, stagePoint(e));
    pinchPrev.current = null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = stagePoint(e);
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, p);
    const pts = [...pointers.current.values()];

    if (pts.length >= 2) {
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pinchPrev.current && pinchPrev.current.dist > 0) {
        const { zoom: z, offset: o } = geom.current;
        const { stage } = dims.current;
        const nextZoom = Math.min(MAX_ZOOM, Math.max(1, z * (dist / pinchPrev.current.dist)));
        const ratio = nextZoom / z;
        const cx = stage / 2 + o.x;
        const cy = stage / 2 + o.y;
        // Zoom about the midpoint AND follow the midpoint's travel (two-finger slide).
        const dmx = mid.x - pinchPrev.current.mid.x;
        const dmy = mid.y - pinchPrev.current.mid.y;
        const ncx = mid.x - (mid.x - cx) * ratio + dmx;
        const ncy = mid.y - (mid.y - cy) * ratio + dmy;
        apply(nextZoom, { x: ncx - stage / 2, y: ncy - stage / 2 });
      }
      pinchPrev.current = { dist, mid };
      return;
    }

    // Single pointer: pan by the travel delta.
    const { offset: o } = geom.current;
    apply(geom.current.zoom, { x: o.x + (p.x - prev.x), y: o.y + (p.y - prev.y) });
  };

  const endPointer = (e: React.PointerEvent) => {
    stageRef.current?.releasePointerCapture?.(e.pointerId);
    pointers.current.delete(e.pointerId);
    pinchPrev.current = null;
  };

  // Native non-passive wheel listener so we can preventDefault the page zoom.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAbout(geom.current.zoom * factor, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAbout, bitmap]);

  async function save() {
    if (!bitmap || !stageSize || !scale) return;
    setSaving(true);
    setError(null);
    try {
      // The circle is inscribed in the square stage; crop that whole square.
      const scaledW = imgW * scale;
      const scaledH = imgH * scale;
      const left = stageSize / 2 + offset.x - scaledW / 2;
      const top = stageSize / 2 + offset.y - scaledH / 2;
      const srcX = -left / scale;
      const srcY = -top / scale;
      const srcSize = stageSize / scale;

      const out = document.createElement('canvas');
      out.width = 512;
      out.height = 512;
      out.getContext('2d')!.drawImage(bitmap, srcX, srcY, srcSize, srcSize, 0, 0, 512, 512);
      const blob = await new Promise<Blob>((res, rej) =>
        out.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.85),
      );
      const { path } = await uploadImage('avatars', blob);
      onCropped({ path, preview: URL.createObjectURL(blob) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
      setSaving(false);
    }
  }

  // Display geometry: natural-size canvas, CSS-scaled and placed by image-center.
  const scaledW = imgW * scale;
  const scaledH = imgH * scale;
  const shown = clampOffset(offset, scale, imgW, imgH, stageSize);

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="avatar-crop-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="text-lg font-semibold text-text">Position your photo</h2>
        <p className="text-sm text-text-muted">
          Drag to move, pinch or scroll to zoom. The circle is what neighbors see.
        </p>

        <div className="flex justify-center">
          <div
            ref={stageRef}
            data-testid="avatar-crop-stage"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            className="relative aspect-square w-full max-w-[288px] touch-none overflow-hidden rounded-lg bg-surface-sunken select-none"
          >
            {bitmap && stageSize > 0 && (
              <canvas
                ref={canvasRef}
                aria-hidden
                className="pointer-events-none absolute origin-top-left"
                style={{
                  width: `${scaledW}px`,
                  height: `${scaledH}px`,
                  left: `${stageSize / 2 + shown.x - scaledW / 2}px`,
                  top: `${stageSize / 2 + shown.y - scaledH / 2}px`,
                }}
              />
            )}
            {/* Circle mask: an inscribed circle whose huge OUTER shadow dims the
                corners (the overflow-hidden stage clips it), with the ring on top. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full border-2 border-border-strong"
              style={{ boxShadow: '0 0 0 9999px var(--color-scrim)' }}
            />
          </div>
        </div>

        <label className="flex items-center gap-3 text-sm text-text-muted">
          <span aria-hidden>−</span>
          <input
            type="range"
            data-testid="avatar-crop-zoom"
            aria-label="Zoom"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!coverScale || saving}
            onChange={(e) => apply(Number(e.target.value), geom.current.offset)}
            className="h-2 flex-1 cursor-pointer accent-accent"
          />
          <span aria-hidden>+</span>
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            data-testid="avatar-crop-cancel"
            onClick={onCancel}
            disabled={saving}
            className="min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="avatar-crop-save"
            onClick={save}
            disabled={saving || !bitmap}
            className="min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70"
          >
            {saving ? 'Saving…' : 'Use photo'}
          </button>
        </div>
      </div>
    </div>
  );
}

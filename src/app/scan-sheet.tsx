'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeScannedCode } from '@/lib/barcode';

declare global {
  interface Window {
    /**
     * e2e seam: feeds a raw scanned value through the sheet's REAL
     * normalize-flash-deliver path (everything below the camera frame loop,
     * which needs physical hardware). Present only while a scan sheet is
     * mounted; calling it does nothing a user couldn't do by scanning.
     */
    __potluckScanEmit?: (rawValue: string) => boolean;
  }
}

/**
 * Camera UPC/EAN scan sheet (blueprint 04 §2): getUserMedia environment
 * camera + the `barcode-detector` ponyfill (W3C BarcodeDetector API over
 * zxing-wasm — iOS Safari never shipped the native one). The ~1MB WASM loads
 * via dynamic import ONLY when this sheet opens; nothing else pays for it.
 *
 * Camera failure is a first-class path (headless browsers, denied permission,
 * plain-http LAN): the sheet explains itself and the manual UPC search stays
 * the fallback. Real-phone verification is tracked in ROADMAP.md.
 *
 * The camera effect runs ONCE per mount: `onDetected` is read through a ref,
 * so an unstable parent callback (or any parent re-render while the sheet is
 * open) can never tear down and restart the stream mid-aim — which would
 * black out the preview and silently reset the torch.
 */
export function ScanSheet({
  onDetected,
  onClose,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<{ track: MediaStreamTrack; on: boolean } | null>(null);
  const [hit, setHit] = useState(false);

  const onDetectedRef = useRef(onDetected);
  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  // One delivery per sheet: the camera loop keeps producing frames during
  // the "got it" flash, and the seam must not double-fire either.
  const deliveredRef = useRef(false);
  const unmountedRef = useRef(false);
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  /**
   * Normalize + flash + hand back — the single path for every detection,
   * camera or seam. Returns whether the value was a deliverable retail code.
   */
  const deliver = useCallback((rawValue: string): boolean => {
    const normalized = normalizeScannedCode(rawValue);
    if (!normalized || deliveredRef.current) return false;
    deliveredRef.current = true;
    // Visual "got it" flash (no haptics API on the web) before handing the
    // code back and closing.
    setHit(true);
    setTimeout(() => {
      if (!unmountedRef.current) onDetectedRef.current(normalized);
    }, 250);
    return true;
  }, []);

  // e2e seam — see the global declaration above.
  useEffect(() => {
    window.__potluckScanEmit = deliver;
    return () => {
      delete window.__potluckScanEmit;
    };
  }, [deliver]);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch (e) {
        if (cancelled) return;
        const name = e instanceof DOMException ? e.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'Camera access was denied. Allow it in your browser settings, or type the UPC into the product search instead.'
            : 'No camera is available here. Type the UPC into the product search instead.',
        );
        return;
      }
      if (cancelled || !videoRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play().catch(() => {});

      // Torch (rear-camera LED) when the device offers it.
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      if (caps?.torch) setTorch({ track, on: false });

      const { BarcodeDetector } = await import('barcode-detector/ponyfill');
      const detector = new BarcodeDetector({ formats: ['upc_a', 'ean_13'] });
      if (cancelled) return;

      const tick = async () => {
        if (cancelled) return;
        if (video.readyState >= 2) {
          try {
            const codes = await detector.detect(video);
            if (cancelled) return;
            for (const code of codes) {
              if (deliver(code.rawValue)) return;
            }
          } catch {
            // A frame that fails to decode is not an error — keep looping.
          }
        }
        timer = setTimeout(tick, 150);
      };
      void tick();
    }

    void start();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [deliver]);

  async function toggleTorch() {
    if (!torch) return;
    const next = !torch.on;
    try {
      await torch.track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorch({ ...torch, on: next });
    } catch {
      // Some devices report torch capability but refuse the constraint.
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="scan-sheet"
        className="flex w-full max-w-md flex-col gap-3 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Scan barcode</h2>
          {torch && (
            <button
              type="button"
              aria-pressed={torch.on}
              onClick={toggleTorch}
              className={`min-h-11 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                torch.on
                  ? 'bg-accent text-accent-contrast'
                  : 'border border-border-strong text-text hover:bg-surface-sunken'
              }`}
            >
              {torch.on ? '🔦 Torch on' : '🔦 Torch'}
            </button>
          )}
        </div>

        {error ? (
          <p role="alert" data-testid="scan-error" className="text-sm text-text">
            {error}
          </p>
        ) : (
          <div className="relative overflow-hidden rounded-lg bg-surface-sunken">
            {/* playsinline: iOS must not hijack into fullscreen video. */}
            <video ref={videoRef} playsInline muted className="aspect-[3/4] w-full object-cover" />
            {/* Aiming guide */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-lg border-2 border-accent/70"
            />
            {hit && (
              <div
                aria-hidden
                data-testid="scan-hit-flash"
                className="absolute inset-0 bg-accent/50"
              />
            )}
          </div>
        )}
        {!error && (
          <p className="text-center text-xs text-text-muted">
            Point at the UPC — it scans automatically
          </p>
        )}

        <button
          type="button"
          data-testid="scan-close"
          onClick={onClose}
          className="min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken"
        >
          {error ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

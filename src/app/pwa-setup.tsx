'use client';

import { useEffect } from 'react';

/**
 * App-wide PWA plumbing, mounted once in the root layout. Renders nothing.
 *
 * - Registers the push-only service worker (public/sw.js) with
 *   updateViaCache: 'none' (Next PWA guide §2). Registration is passive —
 *   no permission prompt, no caching (the SW has no fetch handler).
 * - Captures `beforeinstallprompt` as early as possible: Chrome fires it once
 *   shortly after load, usually before the user reaches /more where the
 *   install card lives. The event is stashed on window and re-announced so a
 *   later-mounted card can still offer the native prompt.
 */

declare global {
  interface Window {
    /** Deferred beforeinstallprompt event, if the browser offered one. */
    __coopInstallPrompt?: Event & { prompt: () => Promise<void> };
  }
}

export function PwaSetup() {
  useEffect(() => {
    // Skip registration under automation (navigator.webdriver, W3C standard):
    // an automated browser can never hold a push-service connection, so the
    // push-only SW is dead weight there — and actively harmful in WebKit,
    // where requests from SW-controlled pages bypass Playwright's route
    // interception (silently disarming response-interception tests). Real
    // browsers are unaffected.
    if ('serviceWorker' in navigator && navigator.webdriver !== true) {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(() => {
          // Non-secure context or private mode — the app works fine without.
        });
    }

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault(); // keep Chrome's mini-infobar quiet; we offer it on /more
      window.__coopInstallPrompt = e as Window['__coopInstallPrompt'];
      window.dispatchEvent(new CustomEvent('coop:installprompt'));
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  }, []);

  return null;
}

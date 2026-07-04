import type { MetadataRoute } from 'next';

/**
 * Web app manifest (blueprint 04 §4 / 02 PWA section). Served at
 * /manifest.webmanifest; Next links it from every page automatically.
 *
 * The manifest spec has a single theme/background color (no per-scheme
 * support), so both use stone-900 per blueprint 02 — the splash screen is
 * dark in both schemes, matching the icon plate. In-browser chrome color
 * follows the actual scheme via the <meta name="theme-color"> pair in
 * layout.tsx's viewport export.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Potluck',
    short_name: 'Potluck',
    description: 'Share your pantry with people you trust, at cost.',
    start_url: '/',
    display: 'standalone',
    background_color: '#1c1917',
    theme_color: '#1c1917',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

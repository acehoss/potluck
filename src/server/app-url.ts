/**
 * Absolute app URLs for links that leave the app (emailed verify/reset links).
 * Mirrors the base-URL convention in `src/server/mail/unsub.ts`: read
 * `MAIL_PUBLIC_URL` at runtime, fall back to the production host, strip any
 * trailing slash. Always https in practice — the auth tokens ride the query and
 * must never traverse a plaintext hop (N8: kept out of logs, not over http).
 */
export function appUrl(path: string): string {
  const base = (process.env.MAIL_PUBLIC_URL || 'https://potluckmutualaid.app').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

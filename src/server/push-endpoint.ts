/**
 * SSRF guard for user-supplied push endpoints. The server POSTs notification
 * payloads to whatever endpoint a member subscribes with, so an unvalidated
 * endpoint is a blind SSRF primitive into the deployment's network (cloud
 * metadata service, LAN devices, sibling containers). Real push services
 * (FCM, APNs, Mozilla autopush, WNS) are always public HTTPS hosts on port
 * 443 with proper DNS names — never IP literals, never intranet names — so
 * anything else is rejected. Enforced at subscribe time AND again at send
 * time (rows stored before this guard existed, or under a different
 * SEED_DEMO setting, must not be fetched either).
 *
 * The one exception: the e2e push sink (an in-app loopback route standing in
 * for FCM/APNs), allowed only on SEED_DEMO=1 stacks and only at its exact
 * loopback location.
 *
 * Kept dependency-free so the unit tests can import it without the Prisma
 * client.
 */
export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (
    process.env.SEED_DEMO === '1' &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
    url.pathname.startsWith('/api/dev/push-sink/')
  ) {
    return true; // e2e sink — demo stacks only
  }
  if (url.protocol !== 'https:') return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[')) return false; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  if (!host.includes('.')) return false; // bare intranet names (https://internal-service)
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    return false;
  }
  return true;
}

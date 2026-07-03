import { TRPCError, initTRPC } from '@trpc/server';
import { getSessionUser } from './auth';

export type Context = {
  /** Session user with household, or null when unauthenticated. */
  user: Awaited<ReturnType<typeof getSessionUser>>;
  /** Best-effort client IP for rate limiting (the trusted-proxy hop). */
  ip: string;
  /**
   * Whether the request arrived over https (directly or via a TLS-terminating
   * proxy). Drives the cookie Secure flag: Safari drops Secure cookies over
   * plain http — localhost included — so it must reflect the real protocol,
   * not NODE_ENV.
   */
  secure: boolean;
};

/**
 * Number of trusted reverse-proxy hops in front of the app (SPEC §6 deploys
 * behind exactly one). A standard proxy APPENDS the real peer to the RIGHT of
 * any client-supplied X-Forwarded-For (nginx `$proxy_add_x_forwarded_for`,
 * Caddy, Traefik), so the trustworthy client value is the Nth entry from the
 * right — NEVER the leftmost, which the client fully controls. Trusting the
 * left hop lets an attacker mint a fresh rate-limit identity per request
 * (login-throttle bypass → unauthenticated argon2 DoS). Override with
 * TRUSTED_PROXY_HOPS only if the topology adds proxies.
 */
const TRUSTED_PROXY_HOPS = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS ?? '1') || 1);

/**
 * The value the trusted proxy contributed to a comma-list forwarded header:
 * the entry TRUSTED_PROXY_HOPS from the right. Returns undefined when the
 * header is absent (direct connection — dev/localhost) so callers fall back.
 */
function trustedForwardedHop(header: string | null): string | undefined {
  if (!header) return undefined;
  const parts = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const idx = parts.length - TRUSTED_PROXY_HOPS;
  return parts[idx >= 0 ? idx : 0];
}

export async function createContext(req: Request): Promise<Context> {
  const proto =
    trustedForwardedHop(req.headers.get('x-forwarded-proto')) ??
    new URL(req.url).protocol.replace(':', '');
  return {
    user: await getSessionUser(),
    ip: trustedForwardedHop(req.headers.get('x-forwarded-for')) ?? 'local',
    secure: proto === 'https',
  };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

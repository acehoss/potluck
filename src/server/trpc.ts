import { TRPCError, initTRPC } from '@trpc/server';
import { getSessionUser } from './auth';

export type Context = {
  /** Session user with household, or null when unauthenticated. */
  user: Awaited<ReturnType<typeof getSessionUser>>;
  /** Best-effort client IP for rate limiting (first x-forwarded-for hop). */
  ip: string;
  /**
   * Whether the request arrived over https (directly or via a TLS-terminating
   * proxy). Drives the cookie Secure flag: Safari drops Secure cookies over
   * plain http — localhost included — so it must reflect the real protocol,
   * not NODE_ENV.
   */
  secure: boolean;
};

export async function createContext(req: Request): Promise<Context> {
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ??
    new URL(req.url).protocol.replace(':', '');
  return {
    user: await getSessionUser(),
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local',
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

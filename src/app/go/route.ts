/**
 * Deep-link landing route (Phase 3 Round D; docs/archive/mutual-aid-rework-2026-07.md N7). A notification
 * (push OR email) points here with `?t=<token>`; this route verifies the
 * nav-only token and does at most two things — switch the acting household and
 * redirect to the target screen.
 *
 * It is NAVIGATION-ONLY by construction: it NEVER creates a session, NEVER
 * performs a mutation, and only ever switches to a household the viewer already
 * belongs to (re-checked against live memberships here — the token is not
 * trusted to grant access). A logged-out visitor is sent through a normal login
 * with a `next=` that re-hits this route once authed, so the household-switch
 * still applies after sign-in. An invalid / expired / tampered / unsafe-path
 * token falls back to `/` — never an error, never an open redirect.
 *
 * The token isn't retained or logged; the route verifies and redirects.
 */

import { redirect } from 'next/navigation';
import { getSessionUser, setActingHouseholdCookie } from '@/server/auth';
import { verifyDeepLinkToken } from '@/server/deeplink';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  if (!token) redirect('/');

  const verified = verifyDeepLinkToken(token);
  if (!verified) redirect('/'); // bad sig / expired / malformed / unsafe path

  const user = await getSessionUser();
  if (!user) {
    // Logged out: land on a normal login, then re-hit /go (now authed) so the
    // household-switch is preserved through the sign-in. The token is nav-only —
    // login is the ONLY thing that authenticates.
    redirect(`/login?next=${encodeURIComponent(`/go?t=${token}`)}`);
  }

  // Switch ONLY to a household the viewer is already a member of. The token
  // carries a household hint, not an authorization — a hint for a household that
  // isn't theirs is simply ignored (they still land on the target screen).
  const isMember = user.memberships.some((m) => m.householdId === verified.householdId);
  if (isMember && user.householdId !== verified.householdId) {
    const proto =
      req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
    await setActingHouseholdCookie(verified.householdId, proto === 'https');
  }

  redirect(verified.path);
}

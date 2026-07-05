import { getSessionUser } from '@/server/auth';
import { resolveVcardTarget } from '@/server/contacts';
import { db } from '@/server/db';
import { buildVcard, vcardContentDisposition } from '@/server/vcard';

/**
 * vCard download for a member (REWORK P5, Round C) — the contact-import path a
 * web app can offer. Session-gated; the target must be reachable from the
 * acting household by the SAME rule contacts.household applies (one shared
 * resolver, `resolveVcardTarget`), so this route can never expose a member the
 * card UI wouldn't. Not tRPC — a browser hits this URL directly to get a file.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response('unauthorized', { status: 401 });

  const { userId } = await params;
  const target = await resolveVcardTarget(db, user.householdId, userId);
  if (!target) return new Response('not found', { status: 404 });

  const body = buildVcard({
    name: target.name,
    org: `${target.householdName} · Potluck`,
    email: target.email,
    phone: target.phone,
    address: target.address,
    bio: target.bio,
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': vcardContentDisposition(target.name),
    },
  });
}

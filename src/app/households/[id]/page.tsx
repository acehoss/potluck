import { notFound, redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { type ContactHousehold, loadContactHousehold } from '@/server/contacts';
import { db } from '@/server/db';
import { ContactPageView } from './contact-page';

/**
 * People & contact page for a household (REWORK P5, Round C). Guards through the
 * SAME resolver the contacts.household query uses (loadContactHousehold): the
 * target must be the acting household's own or an ACTIVE-connected one, else
 * 404 — existence never leaks. Members are already filtered by circle/visibility
 * inside the resolver. Round E wires this into the Neighbors tab; standalone for
 * now, reachable from More / the home household groups / connection rows.
 */
export default async function HouseholdContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  let household: ContactHousehold;
  try {
    household = await loadContactHousehold(db, user.householdId, id);
  } catch {
    notFound();
  }

  return <ContactPageView household={household} isOwn={id === user.householdId} />;
}

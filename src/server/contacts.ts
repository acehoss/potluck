import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';
import { getConnection, reachesMember } from './authz';
import type { db } from './db';

/**
 * Contact-layer resolution (REWORK P5, Round C). ONE implementation of "which
 * members of a household may a viewing household see" — shared by the
 * `contacts.household` tRPC query and the /api/vcard route so they can never
 * drift. The connection itself is the gate (P5: no capability needed); a member
 * is then filtered by their own visibility against the circle the OWNING
 * household placed the viewer into (`reachesMember`). Own-household view is
 * unfiltered.
 */

type Dbc = Prisma.TransactionClient | typeof db;

function prisma(dbc: Dbc): Prisma.TransactionClient {
  return dbc as unknown as Prisma.TransactionClient;
}

/** Own household always; otherwise the member's visibility over the ACTIVE edge. */
async function memberVisibleTo(
  dbc: Dbc,
  viewerHouseholdId: string,
  ownerHouseholdId: string,
  member: { id: string; visibility: string },
): Promise<boolean> {
  if (viewerHouseholdId === ownerHouseholdId) return true;
  return reachesMember(dbc, ownerHouseholdId, viewerHouseholdId, member);
}

const MEMBERSHIP_ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

export type ContactMember = {
  membershipId: string;
  userId: string;
  name: string;
  photoPath: string | null;
  phone: string | null;
  email: string;
  bio: string | null;
};

export type ContactHousehold = {
  householdName: string;
  slug: string;
  address: string | null;
  pickupNotes: string | null;
  members: ContactMember[];
};

/**
 * The viewer household's view of `targetHouseholdId`: pickup logistics plus the
 * members visible to it. The target must be the viewer's OWN household or an
 * ACTIVE-connected one (else 404 — existence never leaks). Own-household is
 * returned in full; a connected household is filtered per member visibility.
 */
export async function loadContactHousehold(
  dbc: Dbc,
  viewerHouseholdId: string,
  targetHouseholdId: string,
): Promise<ContactHousehold> {
  const isOwn = targetHouseholdId === viewerHouseholdId;
  if (!isOwn) {
    const conn = await getConnection(dbc, viewerHouseholdId, targetHouseholdId);
    if (!conn || conn.status !== 'ACTIVE') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Household not found.' });
    }
  }
  const client = prisma(dbc);
  const household = await client.household.findUnique({
    where: { id: targetHouseholdId },
    include: {
      memberships: {
        orderBy: MEMBERSHIP_ORDER,
        include: {
          user: { select: { id: true, name: true, photoPath: true, phone: true, email: true, bio: true } },
        },
      },
    },
  });
  if (!household) throw new TRPCError({ code: 'NOT_FOUND', message: 'Household not found.' });

  const members: ContactMember[] = [];
  for (const m of household.memberships) {
    if (!(await memberVisibleTo(dbc, viewerHouseholdId, targetHouseholdId, m))) continue;
    members.push({
      membershipId: m.id,
      userId: m.user.id,
      name: m.user.name,
      photoPath: m.user.photoPath,
      phone: m.user.phone,
      email: m.user.email,
      bio: m.user.bio,
    });
  }
  return {
    householdName: household.name,
    slug: household.slug,
    address: household.address,
    pickupNotes: household.pickupNotes,
    members,
  };
}

export type VcardTarget = {
  name: string;
  email: string;
  phone: string | null;
  bio: string | null;
  address: string | null;
  householdName: string;
};

/**
 * The vCard payload for `targetUserId` as seen by `viewerHouseholdId`, or null
 * when the viewer may not see that person. A user may belong to several
 * households; we bind the card to the first one in which they are visible to the
 * viewer (own household preferred), and take the address/ORG from it — the same
 * visibility rule `contacts.household` applies, so the two never disagree.
 */
export async function resolveVcardTarget(
  dbc: Dbc,
  viewerHouseholdId: string,
  targetUserId: string,
): Promise<VcardTarget | null> {
  const client = prisma(dbc);
  const user = await client.user.findUnique({
    where: { id: targetUserId },
    include: {
      memberships: {
        orderBy: MEMBERSHIP_ORDER,
        include: { household: { select: { name: true, address: true } } },
      },
    },
  });
  if (!user) return null;

  // Own household first, then any connected household that shows this member.
  const ordered = [...user.memberships].sort((a, b) => {
    const aOwn = a.householdId === viewerHouseholdId ? 0 : 1;
    const bOwn = b.householdId === viewerHouseholdId ? 0 : 1;
    return aOwn - bOwn;
  });
  for (const m of ordered) {
    if (!(await memberVisibleTo(dbc, viewerHouseholdId, m.householdId, m))) continue;
    return {
      name: user.name,
      email: user.email,
      phone: user.phone,
      bio: user.bio,
      address: m.household.address,
      householdName: m.household.name,
    };
  }
  return null;
}

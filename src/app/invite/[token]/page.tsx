import { getSessionUser, hashToken } from '@/server/auth';
import { db } from '@/server/db';
import { BrandMark } from '../../brand-mark';
import { AcceptInviteExisting } from './accept-invite-existing';
import { AcceptInviteForm } from './accept-invite-form';

/** Returns the invite only when it is unclaimed and unexpired. */
async function loadValidInvite(token: string) {
  const invite = await db.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { household: { select: { id: true, name: true } } },
  });
  if (!invite || invite.usedAt || invite.expiresAt.getTime() < Date.now()) return null;
  return invite;
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const sessionUser = await getSessionUser();
  const invite = await loadValidInvite(token);
  const isHouseholdInvite = invite?.kind === 'household';
  // A member invite for a household you already belong to is spent breath.
  const alreadyMember =
    invite &&
    !isHouseholdInvite &&
    sessionUser?.memberships.some((m) => m.householdId === invite.householdId);

  // Headerless page: it carries the notch inset itself (the app header normally
  // does) — pt grows to the safe-area inset but never shrinks below p-6's 1.5rem.
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="flex flex-col items-center text-center">
        <BrandMark className="size-16 text-accent" />
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Potluck</h1>
        {invite ? (
          isHouseholdInvite ? (
            <p className="mt-2 max-w-sm text-sm text-text-muted">
              <span className="font-medium text-text">{invite.household.name}</span> invited you
              to start your own household here — you&apos;ll be connected to them from day one.
            </p>
          ) : (
            <p className="mt-2 max-w-sm text-sm text-text-muted">
              You&apos;ve been invited to join the{' '}
              <span className="font-medium text-text">{invite.household.name}</span> household.
            </p>
          )
        ) : (
          <p role="alert" className="mt-2 max-w-sm text-sm text-danger">
            This invite link is invalid, expired, or already used. Ask for a new one.
          </p>
        )}
      </div>
      {invite && sessionUser && alreadyMember && (
        <p className="max-w-sm text-center text-sm text-text-muted">
          You&apos;re already a member of {invite.household.name} — this invite is for someone
          else.
        </p>
      )}
      {invite && sessionUser && !alreadyMember && (
        <div className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-6 shadow-sm">
          <AcceptInviteExisting
            token={token}
            userName={sessionUser.name}
            kind={isHouseholdInvite ? 'household' : 'member'}
            inviterName={invite.household.name}
          />
        </div>
      )}
      {invite && !sessionUser && (
        <div className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-6 shadow-sm">
          <AcceptInviteForm
            token={token}
            defaultName={invite.invitedName ?? ''}
            kind={isHouseholdInvite ? 'household' : 'member'}
          />
        </div>
      )}
    </main>
  );
}

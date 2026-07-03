import { getSessionUser, hashToken } from '@/server/auth';
import { db } from '@/server/db';
import { BrandMark } from '../../brand-mark';
import { AcceptInviteForm } from './accept-invite-form';

/** Returns the invite only when it is unclaimed and unexpired. */
async function loadValidInvite(token: string) {
  const invite = await db.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { household: { select: { name: true } } },
  });
  if (!invite || invite.usedAt || invite.expiresAt.getTime() < Date.now()) return null;
  return invite;
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const sessionUser = await getSessionUser();
  const invite = await loadValidInvite(token);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center text-center">
        <BrandMark className="size-16 text-accent" />
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Private Coop</h1>
        {invite ? (
          <p className="mt-2 max-w-sm text-sm text-text-muted">
            You&apos;ve been invited to join the{' '}
            <span className="font-medium text-text">{invite.household.name}</span> household.
          </p>
        ) : (
          <p role="alert" className="mt-2 max-w-sm text-sm text-danger">
            This invite link is invalid, expired, or already used. Ask for a new one.
          </p>
        )}
      </div>
      {invite && sessionUser && (
        <p className="max-w-sm text-center text-sm text-text-muted">
          You&apos;re already signed in as {sessionUser.name}. Sign out first to accept this invite
          as a new member.
        </p>
      )}
      {invite && !sessionUser && (
        <div className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-6 shadow-sm">
          <AcceptInviteForm token={token} defaultName={invite.invitedName ?? ''} />
        </div>
      )}
    </main>
  );
}

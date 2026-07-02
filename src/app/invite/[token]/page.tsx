import { getSessionUser, hashToken } from '@/server/auth';
import { db } from '@/server/db';
import { AcceptInviteForm } from './accept-invite-form';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const sessionUser = await getSessionUser();
  const invite = await db.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { household: { select: { name: true } } },
  });
  const valid = invite && !invite.usedAt && invite.expiresAt.getTime() > Date.now();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Private Coop</h1>
        {valid ? (
          <p className="mt-2 text-sm text-stone-500">
            You&apos;ve been invited to join the{' '}
            <span className="font-medium text-stone-700">{invite.household.name}</span> household.
          </p>
        ) : (
          <p role="alert" className="mt-2 text-sm text-red-600">
            This invite link is invalid, expired, or already used. Ask for a new one.
          </p>
        )}
      </div>
      {valid && sessionUser && (
        <p className="max-w-sm text-center text-sm text-stone-500">
          You&apos;re already signed in as {sessionUser.name}. Sign out first to accept this invite
          as a new member.
        </p>
      )}
      {valid && !sessionUser && (
        <AcceptInviteForm token={token} defaultName={invite.invitedName ?? ''} />
      )}
    </main>
  );
}

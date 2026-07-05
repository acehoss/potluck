import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { NotificationPrefs } from './notification-prefs';

/**
 * Notification preferences screen (Phase-3 Round C). Reached from the "How we
 * reach you" card on More. Account-level (not per-device): the category matrix,
 * weekly digest, the show-details privacy toggle, and digest time zone. The
 * per-device push subscription toggle stays on More under "This device".
 */
export default async function NotificationsPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex flex-col gap-1">
        <Link
          href="/more"
          className="text-sm font-medium text-accent hover:underline"
          data-testid="notif-back"
        >
          ← More
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-sm text-text-muted">{user.name} · {user.household.name}</p>
      </header>

      <main>
        <NotificationPrefs />
      </main>
    </div>
  );
}

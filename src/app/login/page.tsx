import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { isSafePath } from '@/server/deeplink';
import { BrandMark } from '../brand-mark';
import { LoginForm } from './login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Open-redirect guard (Round D, N7): a `next` continuation is honored only when
  // it is a same-origin relative path; anything else falls back to `/`.
  const safeNext = isSafePath(next) ? next : '/';

  // Already signed in → skip the form and continue to where they were headed.
  if (await getSessionUser()) redirect(safeNext);

  // Headerless page: it carries the notch inset itself (the app header normally
  // does) — pt grows to the safe-area inset but never shrinks below p-6's 1.5rem.
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="flex flex-col items-center text-center">
        <BrandMark className="size-16 text-accent" />
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Potluck</h1>
        <p className="mt-2 text-sm text-text-muted">
          Share your pantry with people you trust, at cost.
        </p>
      </div>
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-6 shadow-sm">
        <LoginForm next={safeNext} />
      </div>
    </main>
  );
}

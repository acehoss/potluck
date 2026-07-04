import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { BrandMark } from '../brand-mark';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  if (await getSessionUser()) redirect('/');

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center text-center">
        <BrandMark className="size-16 text-accent" />
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Potluck</h1>
        <p className="mt-2 text-sm text-text-muted">
          Share your pantry with people you trust, at cost.
        </p>
      </div>
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-6 shadow-sm">
        <LoginForm />
      </div>
    </main>
  );
}

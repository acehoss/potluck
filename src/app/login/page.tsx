import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  if (await getSessionUser()) redirect('/');

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Private Coop</h1>
        <p className="mt-2 text-sm text-stone-500">
          Share your pantry with people you trust, at cost.
        </p>
      </div>
      <LoginForm />
    </main>
  );
}

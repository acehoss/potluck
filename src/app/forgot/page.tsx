import { BrandMark } from '../brand-mark';
import { ForgotForm } from './forgot-form';

export default function ForgotPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center text-center">
        <BrandMark className="size-16 text-accent" />
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Reset your password</h1>
        <p className="mt-2 max-w-sm text-sm text-text-muted">
          Enter your username or email and we&apos;ll send you a link to set a new one.
        </p>
      </div>
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-6 shadow-sm">
        <ForgotForm />
      </div>
    </main>
  );
}

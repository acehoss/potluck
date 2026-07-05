import { BrandMark } from '../brand-mark';
import { ResetForm } from './reset-form';

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center text-center">
        <BrandMark className="size-16 text-accent" />
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Set a new password</h1>
      </div>
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-6 shadow-sm">
        {token ? (
          <ResetForm token={token} />
        ) : (
          <p role="alert" data-testid="reset-invalid" className="text-center text-sm text-danger">
            This reset link is missing its token. Request a new one from the sign-in screen.
          </p>
        )}
      </div>
    </main>
  );
}

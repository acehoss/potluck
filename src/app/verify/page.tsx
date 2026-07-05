import { BrandMark } from '../brand-mark';
import { VerifyClient } from './verify-client';

/**
 * /verify?token=… — the email-confirmation landing. A tokenless visit just says
 * the link is bad (same generic outcome as an expired one).
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center text-center">
        <BrandMark className="size-16 text-accent" />
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Potluck</h1>
      </div>
      {token ? (
        <VerifyClient token={token} />
      ) : (
        <p
          role="alert"
          data-testid="verify-page"
          className="max-w-sm text-center text-sm text-danger"
        >
          This confirmation link is missing its token. Ask for a fresh link.
        </p>
      )}
    </main>
  );
}

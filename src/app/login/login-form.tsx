'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';

/** The second-factor methods a signed-in-but-pending account offers. */
type MfaChallenge = {
  pendingToken: string;
  methods: { totp: boolean; email: boolean; backup: boolean };
};

export function LoginForm() {
  const trpc = useTRPC();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  // Once the password checks out but a second factor is owed, we hold the
  // pending token here and swap the whole form for the challenge step.
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);

  const login = useMutation(
    trpc.auth.login.mutationOptions({
      onSuccess: (data) => {
        if ('mfaRequired' in data) {
          setChallenge({ pendingToken: data.pendingToken, methods: data.methods });
          return;
        }
        router.push('/');
        router.refresh();
      },
    }),
  );

  if (challenge) {
    return (
      <MfaStep
        challenge={challenge}
        onDone={() => {
          router.push('/');
          router.refresh();
        }}
      />
    );
  }

  return (
    <form
      className="flex w-full flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        login.mutate({ identifier, password });
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        Username or email
        <input
          type="text"
          name="username"
          required
          autoComplete="username"
          autoCapitalize="none"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        Password
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </label>
      {login.error && (
        <p role="alert" className="text-sm text-danger">
          {login.error.message}
        </p>
      )}
      <button type="submit" disabled={login.isPending} className={primaryBtn}>
        {login.isPending ? 'Signing in…' : 'Sign in'}
      </button>
      <Link
        href="/forgot"
        data-testid="login-forgot-link"
        className="text-center text-xs font-medium text-accent hover:underline"
      >
        Forgot your password?
      </Link>
      <p className="text-center text-xs text-text-muted">
        No account? Ask a member of your household for an invite link.
      </p>
    </form>
  );
}

/**
 * Second-factor step: shown after the password is accepted when the account
 * carries any MFA. The account owner picks how to prove it — their
 * authenticator code, a one-time backup code, or (if enabled) a code we email
 * them. We never sign in until this clears; a failed code just re-prompts.
 */
function MfaStep({
  challenge,
  onDone,
}: {
  challenge: MfaChallenge;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const verify = useMutation(
    trpc.auth.mfaChallenge.mutationOptions({
      onSuccess: onDone,
    }),
  );
  const requestEmail = useMutation(
    trpc.auth.requestMfaEmailCode.mutationOptions({
      onSuccess: () => setEmailSent(true),
    }),
  );

  return (
    <form
      data-testid="login-mfa-step"
      className="flex w-full flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        verify.mutate({ pendingToken: challenge.pendingToken, code: code.trim() });
      }}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-text">One more step</h2>
        <p className="text-sm text-text-muted">
          {useBackup
            ? 'Enter one of the backup codes you saved when you turned on two-step sign-in.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        {useBackup ? 'Backup code' : 'Authentication code'}
        <input
          type="text"
          required
          data-testid="login-mfa-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode={useBackup ? 'text' : 'numeric'}
          autoFocus
          className={inputClass}
        />
      </label>

      {verify.error && (
        <p role="alert" className="text-sm text-danger">
          {verify.error.message}
        </p>
      )}

      <button
        type="submit"
        data-testid="login-mfa-submit"
        disabled={verify.isPending}
        className={primaryBtn}
      >
        {verify.isPending ? 'Checking…' : 'Verify and sign in'}
      </button>

      {/* Alternatives, only offered when the account actually has them. */}
      <div className="flex flex-col gap-1 text-center text-xs">
        {challenge.methods.email && !useBackup && (
          <button
            type="button"
            data-testid="login-mfa-request-email"
            onClick={() => requestEmail.mutate({ pendingToken: challenge.pendingToken })}
            disabled={requestEmail.isPending || emailSent}
            className="font-medium text-accent hover:underline disabled:text-text-muted disabled:no-underline"
          >
            {emailSent
              ? 'Code sent — check your email'
              : requestEmail.isPending
                ? 'Sending…'
                : 'Email me a code instead'}
          </button>
        )}
        {challenge.methods.backup && (
          <button
            type="button"
            data-testid="login-mfa-backup-toggle"
            onClick={() => {
              setUseBackup((v) => !v);
              setCode('');
            }}
            className="font-medium text-accent hover:underline"
          >
            {useBackup ? 'Use my authenticator code' : 'Use a backup code'}
          </button>
        )}
      </div>
    </form>
  );
}

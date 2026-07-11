'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * Two-step sign-in (MFA) card on More (Phase-3 Round B; docs/archive/mutual-aid-rework-2026-07.md N8).
 * Every member manages their own second factor here: enroll an authenticator
 * app (QR + secret → confirm a live code → save one-time backup codes), also
 * opt into emailed codes (a code proves inbox control first), or turn TOTP back
 * off with a current code. The instance-admin account is required to keep TOTP
 * (N8) — it's nudged to enroll and its "turn off" control is hidden (can/hide).
 *
 * Follows the Walt rule: plain language, no "TOTP/OTP" jargon in the copy.
 * `isAdmin` comes from the server-rendered More page so we never render the
 * disable control the admin can't use.
 */

const card =
  'flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm';
const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

export function MfaSetupCard({ isAdmin }: { isAdmin: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useQuery(trpc.auth.mfa.status.queryOptions());
  const [enrolling, setEnrolling] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const refresh = () => queryClient.invalidateQueries(trpc.auth.mfa.status.pathFilter());

  if (!status.data) {
    return (
      <section data-testid="mfa-setup-card" className={card}>
        <h2 className="text-lg font-semibold">Two-step sign-in</h2>
        <p className="text-sm text-text-muted">Loading…</p>
      </section>
    );
  }

  const s = status.data;

  // MFA needs an encryption key on the server; without it the whole feature is
  // inoperable, so we say so plainly instead of offering controls that'd fail.
  if (!s.configured) {
    return (
      <section data-testid="mfa-setup-card" className={card}>
        <h2 className="text-lg font-semibold">Two-step sign-in</h2>
        <p className="text-sm text-text-muted" data-testid="mfa-not-configured">
          Two-step sign-in isn&apos;t set up on this server yet — see the README to add an
          encryption key.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="mfa-setup-card" className={card}>
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold">Two-step sign-in</h2>
        {s.totpEnabled && (
          <span
            data-testid="mfa-on-badge"
            className="rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success"
          >
            On
          </span>
        )}
      </div>

      {!s.totpEnabled ? (
        <>
          <p className="text-sm text-text-muted">
            Add a second step at sign-in — a code from an authenticator app on your phone — so a
            stolen password isn&apos;t enough to get into your account.
          </p>
          {s.adminMustEnroll && (
            <p
              data-testid="mfa-admin-nudge"
              className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-text"
            >
              As this server&apos;s admin, you&apos;re asked to turn this on before managing the
              instance.
            </p>
          )}
          <button
            type="button"
            data-testid="mfa-enroll-start"
            onClick={() => setEnrolling(true)}
            className={primaryBtn}
          >
            Turn on two-step sign-in
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            You&apos;ll enter a code from your authenticator app each time you sign in.
          </p>
          <p className="text-sm text-text" data-testid="mfa-backup-remaining">
            {s.backupCodesRemaining} backup{' '}
            {s.backupCodesRemaining === 1 ? 'code' : 'codes'} left.
          </p>

          <EmailCodeSection enabled={s.emailEnabled} onChanged={refresh} />

          {/* The admin account must keep TOTP (N8) — don't offer a control it can't use. */}
          {!isAdmin &&
            (disabling ? (
              <DisableForm
                onDone={() => {
                  setDisabling(false);
                  void refresh();
                }}
                onCancel={() => setDisabling(false)}
              />
            ) : (
              <button
                type="button"
                data-testid="mfa-disable"
                onClick={() => setDisabling(true)}
                className={secondaryBtn}
              >
                Turn off two-step sign-in
              </button>
            ))}
        </>
      )}

      {enrolling && (
        <EnrollSheet
          onClose={() => setEnrolling(false)}
          onDone={() => {
            setEnrolling(false);
            void refresh();
          }}
        />
      )}
    </section>
  );
}

/**
 * Emailed-code factor. Off by default. Enabling proves inbox control: we email
 * a code (beginEmail) and it's on only once that code is confirmed. Turning it
 * off asks for any current code.
 */
function EmailCodeSection({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const trpc = useTRPC();
  const [mode, setMode] = useState<'idle' | 'enrolling' | 'disabling'>('idle');
  const [code, setCode] = useState('');

  const begin = useMutation(
    trpc.auth.mfa.beginEmail.mutationOptions({ onSuccess: () => setMode('enrolling') }),
  );
  const confirm = useMutation(
    trpc.auth.mfa.confirmEmail.mutationOptions({
      onSuccess: () => {
        setMode('idle');
        setCode('');
        onChanged();
      },
    }),
  );
  const disable = useMutation(
    trpc.auth.mfa.disableEmail.mutationOptions({
      onSuccess: () => {
        setMode('idle');
        setCode('');
        onChanged();
      },
    }),
  );

  if (enabled) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border-strong p-3">
        <p className="text-sm font-medium text-text" data-testid="mfa-email-on">
          Emailed codes are on.
        </p>
        <p className="text-sm text-text-muted">
          A backup for when your authenticator app isn&apos;t handy.
        </p>
        {mode === 'disabling' ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              disable.mutate({ code: code.trim() });
            }}
          >
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              Enter a current code to turn emailed codes off
              <input
                type="text"
                required
                data-testid="mfa-email-disable-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                className={inputClass}
              />
            </label>
            {disable.error && (
              <p role="alert" className="text-sm text-danger">
                {disable.error.message}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setMode('idle');
                  setCode('');
                }}
                className={`${secondaryBtn} flex-1`}
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="mfa-email-disable-submit"
                disabled={disable.isPending}
                className={`${primaryBtn} flex-1`}
              >
                {disable.isPending ? 'Turning off…' : 'Turn off'}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            data-testid="mfa-email-disable"
            onClick={() => setMode('disabling')}
            className={secondaryBtn}
          >
            Turn off emailed codes
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-strong p-3">
      <p className="text-sm font-medium text-text">Also get codes by email</p>
      <p className="text-sm text-text-muted">
        A backup for when your authenticator app isn&apos;t handy.
      </p>
      {mode === 'enrolling' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate({ code: code.trim() });
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            Enter the code we emailed you
            <input
              type="text"
              required
              data-testid="mfa-email-confirm"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              className={inputClass}
            />
          </label>
          {confirm.error && (
            <p role="alert" className="text-sm text-danger">
              {confirm.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setMode('idle');
                setCode('');
              }}
              className={`${secondaryBtn} flex-1`}
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="mfa-email-confirm-submit"
              disabled={confirm.isPending}
              className={`${primaryBtn} flex-1`}
            >
              {confirm.isPending ? 'Confirming…' : 'Confirm'}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          data-testid="mfa-email-setup"
          onClick={() => begin.mutate()}
          disabled={begin.isPending}
          className={secondaryBtn}
        >
          {begin.isPending ? 'Sending a code…' : 'Set up emailed codes'}
        </button>
      )}
      {begin.error && (
        <p role="alert" className="text-sm text-danger">
          {begin.error.message}
        </p>
      )}
    </div>
  );
}

/** Inline confirm-with-a-code form to turn TOTP back off. */
function DisableForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const trpc = useTRPC();
  const [code, setCode] = useState('');
  const disable = useMutation(trpc.auth.mfa.disable.mutationOptions({ onSuccess: onDone }));
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border-strong p-3"
      onSubmit={(e) => {
        e.preventDefault();
        disable.mutate({ code: code.trim() });
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        Enter a current code to turn it off
        <input
          type="text"
          required
          data-testid="mfa-disable-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          className={inputClass}
        />
      </label>
      {disable.error && (
        <p role="alert" className="text-sm text-danger">
          {disable.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className={`${secondaryBtn} flex-1`}>
          Cancel
        </button>
        <button
          type="submit"
          data-testid="mfa-disable-submit"
          disabled={disable.isPending}
          className={`${primaryBtn} flex-1`}
        >
          {disable.isPending ? 'Turning off…' : 'Turn off'}
        </button>
      </div>
    </form>
  );
}

/**
 * Enrollment modal: begin (mint secret + QR) → scan/type into an authenticator
 * → confirm a live code → reveal one-time backup codes with a save-ack before
 * we let the user close out.
 */
function EnrollSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const trpc = useTRPC();
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [acked, setAcked] = useState(false);

  // beginTotp is a mutation (it mints + stores a fresh, not-yet-enabled secret);
  // fire it exactly once when the sheet opens.
  const beginMut = useMutation(trpc.auth.mfa.begin.mutationOptions());
  const { mutate: begin } = beginMut;
  useEffect(() => {
    begin({ method: 'totp' });
  }, [begin]);

  const confirm = useMutation(
    trpc.auth.mfa.confirm.mutationOptions({
      onSuccess: (data) => {
        if (data.method === 'totp') setBackupCodes(data.backupCodes);
      },
    }),
  );

  const enroll = beginMut.data?.method === 'totp' ? beginMut.data : null;

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="mfa-enroll-sheet"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        {backupCodes ? (
          <>
            <h2 className="text-lg font-semibold">Save your backup codes</h2>
            <p className="text-sm text-text-muted">
              If you ever lose your phone, one of these codes gets you back in. Each works once.
              Keep them somewhere safe — you won&apos;t see them again.
            </p>
            <ul
              data-testid="backup-codes"
              className="grid grid-cols-2 gap-2 rounded-lg border border-border-strong bg-surface-sunken p-3 font-mono text-sm text-text"
            >
              {backupCodes.map((c) => (
                <li key={c} className="tracking-wider">
                  {c}
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-3 text-sm text-text">
              <input
                type="checkbox"
                data-testid="backup-codes-ack"
                checked={acked}
                onChange={(e) => setAcked(e.target.checked)}
                className="mt-0.5 size-5 accent-[var(--color-accent)]"
              />
              <span>I&apos;ve saved these codes somewhere safe.</span>
            </label>
            <button
              type="button"
              data-testid="mfa-enroll-done"
              disabled={!acked}
              onClick={onDone}
              className={primaryBtn}
            >
              Done
            </button>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">Turn on two-step sign-in</h2>
            <p className="text-sm text-text-muted">
              Open your authenticator app (Google Authenticator, 1Password, and the like), scan
              this square, then enter the 6-digit code it shows.
            </p>

            {beginMut.isPending || !enroll ? (
              <p className="text-sm text-text-muted" data-testid="mfa-enroll-preparing">
                {beginMut.error ? beginMut.error.message : 'Preparing…'}
              </p>
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={enroll.qrDataUrl}
                  alt="Scan this with your authenticator app"
                  data-testid="mfa-qr"
                  className="mx-auto size-48 rounded-lg border border-border bg-surface"
                />
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-text-muted">
                    Can&apos;t scan? Enter this key by hand:
                  </span>
                  <code
                    data-testid="mfa-secret"
                    className="select-all break-all rounded-lg border border-border-strong bg-surface-sunken px-3 py-2 font-mono text-sm tracking-wider text-text"
                  >
                    {enroll.secret}
                  </code>
                </div>

                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    confirm.mutate({ method: 'totp', code: code.trim() });
                  }}
                >
                  <label className="flex flex-col gap-1 text-sm font-medium text-text">
                    Code from your app
                    <input
                      type="text"
                      required
                      data-testid="mfa-confirm"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className={inputClass}
                    />
                  </label>
                  {confirm.error && (
                    <p role="alert" className="text-sm text-danger">
                      {confirm.error.message}
                    </p>
                  )}
                  <button
                    type="submit"
                    data-testid="mfa-confirm-submit"
                    disabled={confirm.isPending}
                    className={primaryBtn}
                  >
                    {confirm.isPending ? 'Checking…' : 'Confirm'}
                  </button>
                </form>
              </>
            )}

            <button type="button" onClick={onClose} className={secondaryBtn}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

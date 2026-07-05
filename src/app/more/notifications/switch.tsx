'use client';

/**
 * A token-only on/off switch (Phase-3 Round C notification prefs). Built as an
 * accessible role="switch" button rather than a checkbox so the settings matrix
 * reads like device settings; the track/thumb use semantic tokens only (no
 * default palette) and stay legible in both schemes. Disabled while a write is
 * in flight so a double-tap can't race the mutation.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  testid,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  testid: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testid}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
        checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface-sunken'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block size-5 rounded-full bg-surface-raised shadow-sm transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

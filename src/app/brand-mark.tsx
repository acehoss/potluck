/**
 * The pantry-jar brand mark (assets/icon.svg's art, plate-less), drawn in
 * currentColor so it follows the scheme's accent token wherever it's used.
 * The label window is a true hole (evenodd), so any background shows through.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden className={className}>
      <rect x="172" y="108" width="168" height="46" rx="16" fill="currentColor" />
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M180 170 h152 a40 40 0 0 1 40 40 v158 a40 40 0 0 1 -40 40 h-152 a40 40 0 0 1 -40 -40 v-158 a40 40 0 0 1 40 -40 Z M196 236 h120 a18 18 0 0 1 18 18 v60 a18 18 0 0 1 -18 18 h-120 a18 18 0 0 1 -18 -18 v-60 a18 18 0 0 1 18 -18 Z"
      />
      <rect x="200" y="272" width="112" height="24" rx="12" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

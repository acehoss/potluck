# 03 — Design system

Fixes the dark-mode breakage: slice-1 pages hardcode light palette classes (`bg-white`, `border-stone-200`) while
`globals.css` flips `body` colors via `prefers-color-scheme` → white cards on near-black text-inverted pages.
Fix = semantic tokens only. System preference only, **no theme toggle in v1**.

**Potluck rebrand (2026-07-04): names/copy only.** Tokens, the emerald accent, and the
jar brand mark all stayed — the contrast table below remains verified as-is. Any future
recolor or new mark must redo §5's rationale and §7's WCAG rows, not just swap values.

Feel: warm, calm, domestic — stone neutrals + emerald, generous whitespace, no SaaS chrome. High contrast for
phone-in-a-basement use: every text pair below clears WCAG AA 4.5:1 (ratios verified with the WCAG formula, table at end).

## 1. Complete `src/app/globals.css` (replace whole file)

```css
@import "tailwindcss";

/* Raw tokens. Light on :root, dark via prefers-color-scheme. No toggle in v1. */
:root {
  --surface: #faf9f7;         /* page bg — warm off-white */
  --surface-raised: #ffffff;  /* cards, inputs, tab bar */
  --surface-sunken: #f0eeeb;  /* code chips, photo placeholders, pressed */
  --border: #e7e5e4;          /* hairlines, dividers */
  --border-strong: #a8a29e;   /* input borders, dashed empty-state */
  --text: #1c1917;
  --text-muted: #57534e;
  --accent: #047857;          /* emerald-700: filled buttons, links, active tab */
  --accent-strong: #065f46;   /* hover on accent; text on accent-soft */
  --accent-contrast: #ffffff; /* text on accent */
  --accent-soft: #d1fae5;     /* badge/tint bg */
  --danger: #b91c1c;          /* danger text; destructive button bg */
  --danger-contrast: #ffffff;
  --danger-soft: #fee2e2;
  --success: #166534;         /* positive money, success banner text */
  --success-soft: #dcfce7;
  --warn: #854d0e;
  --warn-soft: #fef9c3;
}

@media (prefers-color-scheme: dark) {
  :root {
    --surface: #1c1917;         /* warm near-black, not #000 */
    --surface-raised: #292524;
    --surface-sunken: #141210;
    --border: #44403c;
    --border-strong: #79716b;
    --text: #f5f5f4;
    --text-muted: #a8a29e;
    --accent: #34d399;          /* emerald-400 — white-on-emerald fails AA on dark, so flip */
    --accent-strong: #6ee7b7;
    --accent-contrast: #022c22; /* dark text on light-emerald buttons */
    --accent-soft: #0f2e23;
    --danger: #f87171;
    --danger-contrast: #450a0a;
    --danger-soft: #2c1515;
    --success: #4ade80;
    --success-soft: #14261c;
    --warn: #facc15;
    --warn-soft: #2a2410;
  }
}

@theme inline {
  --color-*: initial; /* delete Tailwind's palette: bg-stone-50 etc. no longer compile-out — semantic names only */
  --color-surface: var(--surface);
  --color-surface-raised: var(--surface-raised);
  --color-surface-sunken: var(--surface-sunken);
  --color-border: var(--border);
  --color-border-strong: var(--border-strong);
  --color-text: var(--text);
  --color-text-muted: var(--text-muted);
  --color-accent: var(--accent);
  --color-accent-strong: var(--accent-strong);
  --color-accent-contrast: var(--accent-contrast);
  --color-accent-soft: var(--accent-soft);
  --color-danger: var(--danger);
  --color-danger-contrast: var(--danger-contrast);
  --color-danger-soft: var(--danger-soft);
  --color-success: var(--success);
  --color-success-soft: var(--success-soft);
  --color-warn: var(--warn);
  --color-warn-soft: var(--warn-soft);
  --font-sans: var(--font-geist-sans), system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, monospace;
}

@layer base {
  body {
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-sans); /* scaffold hardcoded Arial here, overriding Geist — fixed */
  }
}
```

## 2. Utility conventions

- `@theme inline { --color-surface: … }` registers real utility names: **`bg-surface`, `text-text-muted`,
  `border-border`, `ring-accent`** — never `bg-[--color-surface]` arbitrary syntax. (`@theme inline` is valid
  Tailwind v4.3 syntax — the shipped `node_modules/tailwindcss/index.css` uses it; `inline` makes utilities emit
  `var(--surface)` directly so the media-query swap works everywhere, including opacity modifiers like `ring-accent/25`.)
- `--color-*: initial` deletes the default palette, so `bg-stone-50`/`text-white` silently generate nothing.
  Guard in CI/pre-commit: `git grep -nE '(bg|text|border|ring|divide)-(stone|emerald|red|green|yellow|white|black)' -- src/` must be empty.
- Dark-mode never uses `dark:` variants — tokens flip themselves. If you type `dark:` you're doing it wrong.
- Focus: `outline-none focus:border-accent focus:ring-2 focus:ring-accent/25` on inputs; `focus-visible:ring-2 focus-visible:ring-accent` on buttons.
- Shadows are invisible on dark; borders are the separator. Always pair `shadow-sm` with `border border-border`.
- e2e covers both schemes for free: set `colorScheme: 'dark'` on the existing webkit Playwright project, keep chromium light.

## 3. Component recipes (copy-paste class strings)

```tsx
// Page shell (matches slice-1; add pb-24 on pages with the tab bar)
<div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 sm:p-6">

// Card
<section className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm">

// Buttons — min-h-11 = 44px tap target
<button className="min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50">           {/* primary */}
<button className="min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50">   {/* secondary */}
<button className="min-h-11 rounded-lg bg-danger px-4 py-2.5 font-medium text-danger-contrast transition-colors hover:opacity-90 disabled:opacity-50">                 {/* destructive */}

// Input + label (text-base = 16px, prevents iOS focus zoom)
<label className="flex flex-col gap-1 text-sm font-medium text-text">
  Unit price
  <input className="min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25" />
</label>

// Badge ("your household", "on loan", lot codes)
<span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">

// Tab bar (bottom nav; live set since the Round-E IA flip, 2026-07-04: Neighbors · Plan · Home · More)
<nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-surface-raised pb-[env(safe-area-inset-bottom)]">
  <Link className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-accent">        {/* active */}
  <Link className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-text-muted">    {/* inactive */}
</nav>

// List row (inventory, ledger) — parent: <ul className="divide-y divide-border">
<li className="flex min-h-14 items-center justify-between gap-3 py-3">
  <div className="min-w-0">
    <p className="truncate text-base text-text">Kirkland Diced Tomatoes</p>
    <p className="text-sm text-text-muted">Lot 260702-01 · 8 left · $1.12/ea</p>
  </div>
  <span className="shrink-0 font-mono text-sm tabular-nums text-text-muted">×8</span>
</li>

// Empty state
<div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
  <p className="text-sm font-medium text-text">Nothing here yet</p>
  <p className="text-sm text-text-muted">Receive a restock to stock this pantry.</p>
</div>

// Hero number (net position; text-success when up, text-danger when down, text-text at $0)
<p className="text-4xl font-semibold tabular-nums tracking-tight text-success">+$12.40</p>
<p className="mt-1 text-sm text-text-muted">You’re up with the Smiths</p>
// Restock code end-screen: <p className="font-mono text-5xl font-bold tracking-widest">260702-01</p>

// Banner — swap success→warn→danger triple for variants; role="alert" for danger, role="status" otherwise
<div role="status" className="rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-sm font-medium text-success">
```

## 4. Type scale & spacing rhythm

| Role | Classes |
| --- | --- |
| Caption / labels / badges | `text-xs` (uppercase labels: `text-xs font-medium uppercase tracking-wide text-text-muted`) |
| Secondary body, list metadata | `text-sm` |
| Body, inputs, list primary | `text-base` (never smaller on inputs — iOS zoom) |
| Card title | `text-lg font-semibold` |
| Page title | `text-xl font-semibold tracking-tight` |
| Auth hero | `text-3xl font-semibold tracking-tight` |
| Hero number / restock code | `text-4xl` / `text-5xl`, always `tabular-nums` (money) or `font-mono` (codes) |

Spacing: 4px grid. Page sections `gap-6`; inside cards `gap-4`/`mt-3`; list rows `py-3`; card padding `p-4`;
touch targets ≥44px (`min-h-11` buttons/inputs, `min-h-14` tappable rows). Radii: `rounded-lg` controls, `rounded-xl` cards, `rounded-full` badges.

## 5. Accent decision: keep emerald, split by scheme

Emerald stays — green reads pantry/garden/fresh, sits naturally on warm stone, and slice-1 already shipped it.
But one emerald cannot serve both schemes: white on emerald-600 is **3.77:1 (AA fail)**. So: light = emerald-700
fill + white text (5.48:1); dark = emerald-400 fill + emerald-950 text (7.88:1) — brighter accent doubles as
link/active color on dark (7.89:1 on cards). Handled entirely by the token swap; components never know.

## 6. Slice-1 migration (mechanical find→replace, then run the §2 grep)

| Old (light-hardcoded) | New |
| --- | --- |
| `layout.tsx` body `bg-stone-50 text-stone-900` | delete both (base layer owns body); keep `min-h-full flex flex-col` |
| `border-stone-200 bg-white` (cards) | `border-border bg-surface-raised` |
| `text-stone-400` / `text-stone-500` / `text-stone-600` | `text-text-muted` |
| `text-stone-700` (invite page emphasis) | `text-text` |
| badge `bg-emerald-100 … text-emerald-800` | `bg-accent-soft … text-accent-strong` |
| inputs `border-stone-300 bg-white` | `border-border-strong bg-surface-raised` |
| `focus:border-emerald-600 focus:ring-emerald-100` | `focus:border-accent focus:ring-accent/25` |
| primary `bg-emerald-700 text-white hover:bg-emerald-800` | `bg-accent text-accent-contrast hover:bg-accent-strong` |
| outline `border-emerald-700 text-emerald-800 hover:bg-emerald-50` | secondary recipe (drop the emerald outline variant) |
| secondary `border-stone-300 text-stone-600 hover:bg-stone-100` | `border-border-strong text-text hover:bg-surface-sunken` |
| `text-red-600` (form errors) | `text-danger` |
| invite `<code>` `bg-stone-100` / divider `border-stone-100` | `bg-surface-sunken` / `border-border` |

Files: `layout.tsx`, `page.tsx`, `invite-member.tsx`, `logout-button.tsx`, `login/page.tsx`, `login/login-form.tsx`,
`invite/[token]/page.tsx`, `invite/[token]/accept-invite-form.tsx`. Done = grep clean + Playwright green on
chromium (light) and webkit (`colorScheme: 'dark'`).

## 7. Verified contrast (WCAG relative-luminance formula; AA normal text = 4.5)

| Pair | Light | Dark |
| --- | --- | --- |
| text on surface / raised | 16.62 / 17.49 | 16.03 / 13.90 |
| text-muted on surface / raised | 7.25 / 7.63 | 6.93 / 6.01 |
| accent as text on raised | 5.48 | 7.89 |
| accent-contrast on accent (buttons) | 5.48 | 7.88 |
| danger on raised / danger-contrast on danger | 6.47 / 6.47 | 5.48 / 5.84 |
| success on success-soft (banner) | 6.49 | ≥8.7 |
| warn on warn-soft (banner) | 6.38 | ≥9.9 |
| danger on danger-soft (banner) | 5.30 | ≥5.5 |
| accent-strong on accent-soft (badge) | 6.78 | ≥7.9 |

# 02 — UX Flows (slices 2–7)

Mobile-first at 390px; desktop is the same layouts centered at `max-w-2xl` (slice-1 convention).
Sheets = bottom sheets on mobile, centered modals ≥sm. All money rendered from integer cents.

## Navigation shell (lands with slice 2, grows a tab per slice)

Bottom tab bar, fixed, 4 tabs — `▣ Pantries · ◫ Ledger · ⛏ Items · ☰ More` — hidden
inside the receive wizard (full-screen flow).

- **Pantries** `/` — the old dashboard route becomes this tab: every pantry across all
  households (transparency principle), each row → pantry inventory.
- **Ledger** `/ledger` (slice 3) and **Items** `/items` (slice 6) — greyed with a
  "slice N" tooltip until built.
- **More** `/more` — household members, invite link (moved from old dashboard), sign out,
  install-app help (slice 7). Desktop: same four entries as a top nav row; content identical.

**Slice-1 retrofits:** `/login` and `/invite/[token]` keep working as-is (add app name/icon +
theme color only, slice 7). The old dashboard (`src/app/page.tsx`) is *replaced* by the
Pantries tab; its members/invite section moves to `/more`; its "net position —" placeholder
dies in favor of `/ledger`.

## Pantries tab `/`

```text
┌──────────────────────────┐
│ Private Coop      Aaron  │
│ You're up $12.40 w/Smiths│  ← net strip, tap → /ledger (slice 3+)
│ ── Your household ────── │
│ ▸ Basement    142 units  │  ← counts live (sum of lot remainders);
│ ▸ Chest freezer 38 units │    empty row: "empty — tap to stock"
│ ── Smiths ────────────── │
│ ▸ Basement     97 units  │  ← tap any pantry → inventory
└──────────────────────────┘
```

## Pantry inventory `/pantries/[id]`

Grouped by product; product rows expand to lots. FAB `+ Receive` only on your own
household's pantries (any member can receive into any own pantry).

```text
┌──────────────────────────┐
│ ← Basement (Smiths)      │
│ [search products…]  [scan]│
│ ┌ 🖼 Diced tomatoes  24 ┐│  ← product photo, total remaining
│ │  ▸ 260114-01 18 left  ││   lot rows: code · remaining ·
│ │    3mo old · BB 08/26  ││   age · best-by (if set) · ⋯menu
│ │  ▸ 251002-02  6 left  ││
│ └───────────────────────┘│
│  🖼 Olive oil          4 │
│                    (+ Receive)│
└──────────────────────────┘
```

- Sort: products alphabetical; lots oldest-first (FIFO order visible, never enforced).
  Best-by within 30 days → amber date; past → red + "expired".
- Empty state: "Nothing here yet." + `Receive a restock` button (own pantry) or
  "The Smiths haven't stocked this pantry yet." (theirs).
- Lot `⋯` menu → Recount / Write off / View restock (slice 4; hidden till then).
  `[scan]` = UPC camera scan filtering the list (slice 7; hidden before).

## Receiving wizard (slice 2; slice 5 only prefills step 3)

One server-side `Restock` draft (status `DRAFT`→`FINALIZED`, per 01), created at step 1,
PATCHed per step — survives refresh, tab-kill, and the camera app eating the page. Each
receipt line **is** a draft `Lot` row (01 D4), created/edited in steps 3–4. Route:
`/pantries/[id]/receive/[restockId]?step=n`. Resume banner on the pantry screen if a draft
exists. Full-screen, no tab bar, `✕` abandons (confirm; deletes draft + photos).

**Step 1 — Start.** Sheet over pantry: retailer (text, recent-retailers chips), date
(default today), purchaser household (default yours; picking the other household is the
"credit them at cost" case), receipt total (cents keypad). → creates draft.

**Step 2 — Receipt photos.** Camera/file input (`<input capture="environment">`), thumbnails
row, `+ page` for multi-page, delete per thumb. Photos upload immediately (they're
first-class, retained forever). `Skip photos` allowed (pure manual entry). → Next.
Slice 5: after upload, "Extract lines ✨" button appears; spinner → lines land in step 3
flagged `proposed`; on API failure, toast "Extraction unavailable — enter lines manually".

**Step 3 — Line review.** THE screen. VLM-proposed lines render identically to manual ones,
just with a dot needing confirm-by-touch (any edit or row-tap clears it).

```text
┌──────────────────────────┐
│ ✕  Review lines    (3/4) │
│ Lines $84.50 / Rcpt $86.02│ ← running reconcile banner
│ ⚠ $1.52 short            │
│ ● KS Diced Tom 8ct       │
│   8 units · $8.99 → $1.12/u│
│   recv 8/8 · BB —        │
│ ○ Olive oil 2L           │
│   1 unit · $17.49        │
│   recv 0/1  ⌂ held back  │
│ [+ Add line]      [Next] │
└──────────────────────────┘
```

Tapping a row (or `+ Add line`) opens the **line sheet**:

```text
│ Product  [search… ▾][UPC] │  search-as-you-type over Product;
│   ▸ KS Diced Tomatoes     │  top result "Create 'kirkland dic…'"
│ Units  [−] 8 [+]          │  when no match — create inline, zero
│ Line total  $ [ 8.99 ]    │  extra screens. [UPC] = scan (slice 7)
│ Received [−] 8 [+] of 8   │  default = all; 0 ⇒ personal item
│ Best-by [ mm/yy optional] │
│           [Delete] [Save] │
```

Unit cost preview = `roundHalfUp(lineTotalCents / units)`, exactly the value 01 D1 freezes
at finalize; all money then moves as `count × unitCost` (paper drift stays off the ledger).
**Tap budget per manual line: 5** — `+ Add line`
(1), pick/create product (2), units (stepper, usually 1 tap) (3), total field focus (4;
keystrokes don't count), `Save` (5). Best-by and received-count are optional extras. A
VLM-prefilled line is 1 tap (row-tap to confirm) or 0 if edited implicitly by Save-all.

**Step 4 — Unit photos.** One card per line with `received > 0` and a *new* lot; camera per
card; existing product photo shown beside for "did the packaging change?" comparison.
`Skip` per card allowed (warn once: "no photo — lot label only"); photos addable later from
the lot `⋯` menu. Newest lot photo becomes the product display photo automatically.

**Step 5 — Reconcile + finalize.** Summary: line count, received units, sum vs
`receiptTotal`. Delta within the **01 D7 auto-pass threshold** → green "Reconciled";
outside → amber, finalizing requires an extra "Finalize anyway — receipt differs by $1.52"
confirm tap. Never blocking (low ceremony; tax and unreceived-line edge cases exist).
Finalize freezes each lot's `unitCost` (01 D1), sets `remainingCount`, posts the purchaser
credit (if cross-household), and assigns the restock code — lots already exist from step 3.

**Step 6 — Done.**

```text
┌──────────────────────────┐
│      Restock finalized   │
│      ██  260114-01  ██   │  ← code at ~15vw, high contrast, stays
│ 6 lots · 34 units · $84.50│   on screen for masking-tape labeling
│      [Back to pantry]    │
└──────────────────────────┘
```

Code also permanently visible on restock detail (`/restocks/[id]`: photos, lines, credit).

## Take flow (slice 3) — 2 taps

From pantry inventory, tap a **product row** → take sheet (expanding lots is the *other*
affordance: chevron only). Oldest lot preselected with a `FIFO` badge; qty 1.

```text
│ Take: Diced tomatoes      │
│ Lot [260114-01 ▾] FIFO✓   │  ← dropdown to override, never forced
│   18 left · BB 08/26      │
│ Qty [−] 1 [+]   $1.12/u   │
│ You'll owe Smiths $1.12   │  ← own pantry: "No charge — your
│              [Take]       │     pantry" (identical sheet otherwise)
```

Tap product (1) → `Take` (2). Confirmation toast with `Undo` (10s) → same edit/undo path as
ledger entry edit. Overtake (qty > remaining) blocked at the stepper.

## Ledger `/ledger` (slice 3) + Settle (slice 4)

```text
┌──────────────────────────┐
│ Ledger        [pair ▾]   │  ← pair picker only if >2 households
│ ┌──────────────────────┐ │
│ │  You're up  $12.40   │ │  ← hero, one number per pair
│ │  with the Smiths     │ │
│ │      [Settle up]     │ │
│ └──────────────────────┘ │
│ [All][Takes][Credits][Pay]│ ← type chips, the only filter
│ 07/02 Take 2× tomatoes -$2.24│
│ 07/01 Restock credit +$86.02│
│ 06/28 Settlement Venmo -$40 │
└──────────────────────────┘
```

Entries append-only, newest first, each row → detail (who/what/lot/restock link; takes get
Edit/Undo here). **Settle sheet:** amount (prefilled to zero the pair), direction (prefilled
toward zero, swappable), method chips `Cash / Venmo / Other`, note. Posts a Settlement entry;
both households see it flagged "new" until viewed (`User.ledgerSeenAt`, 01 slice 4; push is
slice 7). **Manual adjustment sheet** (slice 4): `⋯` in the ledger header → "Manual
adjustment" — amount (cents keypad), direction (`they owe us` / `we owe them`), required
note. Posts an ADJUSTMENT entry; the counterparty household is notified per 01's authz
matrix (flagged "new"; push at slice 7).

## Adjustments (slice 4) — live on the lot `⋯` menu, no dedicated screen

- **Recount:** sheet "Counted how many? [−] 14 [+] (app says 18)" → `Save`. No ledger
  effect in v1 (owner eats drift); logged as an Adjustment entry.
- **Write off:** qty (default all remaining) + reason chips `Expired / Damaged / Other` +
  note. Owner eats cost; logged as Adjustment, visible in ledger list (net $0).

## Lending (slice 6)

`/items`: photo grid, name + owner + status pill (`Available` / `Out → Smiths`), fee badge
only when nonzero (`$5/loan`). `+ Item` (name, photo, notes, fee — default $0).

```text
│ ← Pressure canner  🖼    │  /items/[id]
│ Yours · fee $0 · notes…  │
│ Status: Out to Smiths    │
│  since 06/12 · due 07/12 │
│ [Return…]  (or [Check out…])│
│ History: 3 loans ▾       │
```

**Check out sheet:** borrower is always the acting user — no picker (01: `Loan.borrowerId`
is a user, checkout authz "borrower = self"); due date (optional), fee shown read-only if
nonzero with "posts to ledger now". **Return sheet:** condition note (optional) → status
flips, note lands in loan history. Fee posts on checkout, not return (spec §4).

## PWA (slice 7)

- Manifest: name **"Private Coop"**, short_name **"Coop"**, theme/background `#1c1917`
  (stone-900) with emerald-500 accent icon — a simple pantry-jar mark, maskable 512/192px.
- Install: Android/Chrome → `beforeinstallprompt`, deferred to a dismissible card on `/more`.
  iOS → no API; `/more` card shows Share-→-Add-to-Home-Screen pictogram steps.
- Camera UPC scan (`zxing-wasm` or similar) unhides the `[scan]` buttons in pantry search
  and the line-sheet product picker.
- Push (installed PWAs, iOS 16.4+): opt-in on `/more`; events (the one list, matching 04 §4):
  settlement recorded, manual ledger adjustment. Nothing else — no chatty notifications, and
  no loan-due reminders in v1 (they'd need a scheduler the container design doesn't have).

## Playwright anchors (definition of done, chromium + webkit)

Per slice, e2e drives the real flow: s2 full receive wizard incl. hold-back line + code
screen assert; s3 two-tap take + own-pantry no-charge + ledger math; s4 settle-to-zero +
recount + write-off; s5 mocked-VLM prefill → confirm → post; s6 checkout/fee/return; s7
manifest + scan-button visibility. Test ids follow slice 1's `data-testid` convention.

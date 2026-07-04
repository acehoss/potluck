# 02 — UX Flows (slices 2–7)

Mobile-first at 390px; desktop is the same layouts centered at `max-w-2xl` (slice-1 convention).
Sheets = bottom sheets on mobile, centered modals ≥sm. All money rendered from integer cents.

## Navigation shell (lands with slice 2, grows a tab per slice)

Bottom tab bar, fixed — `▣ Pantries · ▤ Orders · ◫ Ledger · ⛏ Items · ☰ More` — hidden
inside the receive wizard (full-screen flow). *(**Orders** added 2026-07-03 → 5 tabs;
`/orders` list + `/orders/[id]` detail — see the Order flow section below.)*

- **Pantries** `/` — the old dashboard route becomes this tab. ~~Every pantry across all
  households (transparency principle)~~ *(superseded 2026-07-04 — Round 1)*: the acting
  household's own pantries **+ the SHARED pantries of ACTIVE connections that extend the
  pantry grant**. Each row → pantry inventory. Net strips for every connected counterparty
  (any status once a balance exists). See the Pantries tab section.
- **Ledger** `/ledger` (slice 3) and **Items** `/items` (slice 6) — greyed with a
  "slice N" tooltip until built.
- **More** `/more` — household members, invite link (moved from old dashboard), sign out,
  install-app help (slice 7). Desktop: same four entries as a top nav row; content identical.
  *(Round 1, 2026-07-04, top → bottom):* the **acting-household switcher** card ("Acting
  as…", **multi-membership users only** — single-membership never see it; switching
  full-reloads to re-scope everything); the **Connections** card (request by `@handle`,
  accept-with-preset, unilateral grant editing, sever/withdraw, and an "Invite a NEW
  household…" flow); the household's own **`@handle`** line ("share it so others can
  connect"); and — **instance admin only** — an **Instance admin** card linking `/admin`
  (per-household usage view + the household-invite growth toggle).

**Slice-1 retrofits:** `/login` and `/invite/[token]` keep working as-is (add app name/icon +
theme color only, slice 7). The old dashboard (`src/app/page.tsx`) is *replaced* by the
Pantries tab; its members/invite section moves to `/more`; its "net position —" placeholder
dies in favor of `/ledger`.

**Login & onboarding (Round 1, 2026-07-04).** `/login`'s field is **"Username or email"**
(the `identifier` — `@` disambiguates; registration also collects an explicit username). The
accept page **branches on `invite.kind`**: a **member** invite adds you to an existing
household; a **household** invite founds a **NEW** household (the newcomer names it) already
connected to the inviter — the first edge (A1). Both invite kinds **work while signed in**: a
signed-in acceptance grants an **additional membership** and **switches the acting household**
to the joined/founded one (A3). New households start pantry-less → add the first pantry from
the Pantries tab's "+ Add a pantry".

## Pantries tab `/`

```text
┌──────────────────────────┐
│ Potluck           Aaron  │
│ You're up $12.40 w/Smiths│  ← net strip, tap → /ledger (slice 3+)
│ ── Your household ────── │
│ ▸ Basement    142 units  │  ← counts live (sum of lot remainders);
│ ▸ Chest freezer 38 units │    empty row: "empty — tap to stock"
│      + Add a pantry      │  ← own group only, manageHousehold (R1S4)
│ ── Smiths ────────────── │
│ ▸ Basement     97 units  │  ← tap any pantry → inventory
└──────────────────────────┘
```

**Round-1 scoping (2026-07-04).** The list is the acting household's own pantries **plus
the SHARED pantries of ACTIVE connections that grant `pantry`** — not "every pantry"
anymore (a private pantry, or a connection without the pantry grant, simply doesn't appear;
existence never leaks). **Net strips** render for every connected counterparty in **any
status** once a balance exists — a **severed** pair keeps its strip while the net is nonzero
(so it stays settleable and reachable). The own-household group gains an inline **"+ Add a
pantry"** affordance (`pantry.create`, **manageHousehold** — the founding path for a brand-new
household that started pantry-less).

## Pantry inventory `/pantries/[id]`

Grouped by product; product rows expand to lots. FAB `+ Receive` only on your own
household's pantries. ~~any member can receive into any own pantry~~ *(tightened
2026-07-04 — Round 1)*: receiving is a **pantry-owner-household action** gated by the
**receiveStock** capability (a member without it — Child preset — sees a Receive FAB that
403s; capability-hiding the affordance is a tracked polish gap). The pantry **header** gains
a **shared/private chip** (shown to the owner household with **manageHousehold**; toggles
`pantry.setShared`), and the **History** link (→ `/pantries/[id]/restocks`, the books) is
**owner-household-only**.

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

**Round-1 authz (2026-07-04).** Receiving is a **pantry-owner-household** action + the
**receiveStock** capability; the wizard shell **redirects a non-owner viewer to the restock
detail** (no stranded purchaser-side cockpit). The **restock detail** (`/restocks/[id]`)
shows *the books* — purchaser credit, receipt images, totals, adjustments, and all takes —
**only to the owner and purchaser households**; a **pantry-granted third household** sees the
inventory story plus **its own** takes, never the credit/receipt/totals. Finalize re-verifies
the purchaser connection is ACTIVE at the money moment (grant/edge lost while drafting → the
credit won't post).

**Step 1 — Start.** Sheet over pantry: retailer (text, recent-retailers chips), date
(default today), purchaser household (default the acting household; picking another is the
"credit them at cost" case — the picker offers **the acting household + its ACTIVE
connections**, no longer free client input; the server constrains it too), receipt total
(cents keypad). → creates draft.

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

> **Superseded 2026-07-03 by Orders (below).** Everything is now a request — the instant
> take sheet is gone (tapping a product opens **Add to order** instead; `take.create`
> removed). The sketch below is retained for history. A take now materialises only at
> order pickup (D9); `take.undo` remains the return path.

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

## Order flow (2026-07-03) — request → fulfil → pickup

Units leave a pantry only through an **Order** (blueprint 01 D9). Availability shown
everywhere is `remaining − reserved`.

- **Build (requester).** Pantry inventory: tapping a product opens the **Add to order**
  sheet (same lot-select + FIFO badge + qty stepper as the old take sheet; capped at
  availability). Adds to a DRAFT cart for that pantry; a **cart bar** at the bottom → the
  order. Own-pantry orders run the same flow.
- **`/orders`** — a new tab. Two lists: **your orders** (DRAFT resumable, plus active/past)
  and, for a pantry owner, **incoming requests**.
- **`/orders/[id]`** — the shared hub; visible actions switch on `status × role`:
  - Requester, DRAFT/REQUESTED: qty steppers (edit until picking), **Request**, Cancel.
  - Owner, REQUESTED → **Start picking** (locks edits) → PICKING → **Mark ready** → READY.
  - READY: either household → **Mark picked up** (money posts here).
  - PICKED_UP shows the receipt/cost; CANCELED notes nothing was charged.

Lifecycle `DRAFT → REQUESTED(reserve) → PICKING(lock) → READY → PICKED_UP(money) /
CANCELED(release)`. Money posts append-only at pickup only; cancel touches nothing.

**Round-1 authz (2026-07-04).** Building/editing/cancelling a draft needs **placeOrders**;
**cross-household submission and any edit to a submitted cross-household order** need
**spend** (a placeOrders-only member drafts, a spend-holder submits/adjusts); the owner side
(**Start picking / Mark ready / decline**) needs **fulfill**. Browsing and ordering a
**connected** pantry rides its owner's **pantry grant + the pantry being shared** — and that
reach is **re-verified at pickup**, the money moment (grant revoked or edge severed while
READY → 409 "cancel instead"; cancel deliberately stays grant-free so reservations always
release). Own-pantry orders run the whole flow at $0.

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

**Round-1 authz (2026-07-04).** The counterparty list (and the `[pair ▾]` picker) is built
from **Connection edges in ANY status** — including SEVERED — so a severed pair keeps its
history and stays reachable (B6). **Settle and manual adjustment need the settleMoney
capability plus an edge to that household in any status**; they deliberately do **not** need
an ACTIVE connection (severed pairs can still settle to zero), but an **unconnected**
household is unreachable (404 — no probing arbitrary household ids).

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

**Check out sheet:** the borrower is the **acting household** (snapshotted as
`Loan.borrowerHouseholdId` at checkout, never re-derived from the user); due date (optional),
fee shown read-only if nonzero with "posts to ledger now". **Return sheet:** condition note
(optional) → status flips, note lands in loan history. Fee posts on checkout, not return
(spec §4).

**Round-1 authz (2026-07-04).** `/items` shows own items **+ the shared items of connections
that grant `lending`** (scoped by the **lending grant × `Item.shared`** — a private item, or a
connection without the grant, doesn't appear). Checkout needs **lendBorrow**; a
**cross-household** checkout additionally needs `Item.shared` + the lending grant, and
**spend** when the fee > 0. The item edit sheet's **"Shared with connections" checkbox is
manageHousehold-gated** (on top of lendBorrow); **setting or editing a fee needs settleMoney**
(pricing future cross-household income is a money act — teens can't unilaterally do it).

## PWA (slice 7)

- Manifest: name **"Potluck"**, short_name **"Potluck"** (renamed 2026-07-04), theme/background `#1c1917`
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
screen assert; s3 two-tap take *(the take is now driven via order pickups — see
`orders.spec.ts`)* + own-pantry no-charge + ledger math; s4 settle-to-zero + recount +
write-off; s5 mocked-VLM prefill → confirm → post; s6 checkout/fee/return; s7 manifest +
scan-button visibility. Test ids follow slice 1's `data-testid` convention.

**Round-1 network-core anchors (2026-07-04):**

- **`network.spec.ts`** — the acting-household switcher re-scopes the whole app and never
  shows for single-membership users; unconnected/ungranted households are invisible (Nia's
  scoped world); a pantry grant gates ordering (share-only neighbor 404 vs granted 200); Teen
  capabilities (draft yes, cross-household submit + money/inventory ops denied); money can't
  post between unconnected households even for a user who belongs to both sides; receiving is
  a pantry-owner action and purchaser attribution must be a connected household.
- **`connections.spec.ts`** — the full connection lifecycle (request by handle → directional
  accept → unilateral grant edit → sever with B6 fallout: auto-cancel + reservation release +
  still-settleable + re-requestable); only manageConnections may run it; a private pantry and
  a private item each hide from connections and reappear when re-shared (the item flag is
  manageHousehold-gated).
- **`onboarding.spec.ts`** — a household invite founds a new connected household (anonymous
  acceptance); a signed-in user accepts a member invite into a second household and gets the
  switcher; the instance-admin usage view + growth toggle + non-admin gates; household-invite
  minting needs manageConnections.

# Private Coop — Build Plan

Tracks slice status and progress notes. The scope contract is [SPEC.md](./SPEC.md) §7.

**Definition of done for a slice:** feature demonstrated working in a real browser against the real compose stack, Playwright e2e passing, progress notes updated here. A slice is never "complete" on the strength of unit tests alone.

| # | Slice | Status |
| --- | ----- | ------ |
| 1 | Skeleton — compose, invite-only auth, households/pantries | ✅ done 2026-07-02 |
| 2 | Receiving — receipt capture, review/receive flow, lots, unit photos, inventory view | ✅ done 2026-07-02 |
| 3 | Takes & ledger — take flow, FIFO suggestion, net position | ✅ done 2026-07-02 |
| 4 | Settlements & adjustments — payments, recounts, write-offs | ✅ done 2026-07-02 |
| 5 | VLM extraction — receipt images prefill the receiving screen | ✅ done 2026-07-02 |
| 6 | Lending — items, loans, returns, fees | ✅ done 2026-07-02 |
| 7 | PWA polish — install, camera scanning, push | ✅ done 2026-07-02 |

## Pre-handoff hardening (post-slice-7 audit)

**2026-07-03 — final-review remediations (money / security / ops).** A pre-go-live audit of the committed v1 confirmed a set of critical/major findings; fixed and re-proven end-to-end (full `down -v && build && SEED_DEMO=1 EXTRACTION_MODE=fixture up --wait && npx playwright test`, **133 passed + 3 intentional skips, both engines, zero failures**).

- **Correct-credit op now exists (money, major).** Blueprint 01 Immutability + invariant 5 define the only auditable fix for a RESTOCK_CREDIT posted against a wrong `receivedCount` caught after finalize — and it was never implemented, leaving the reversed-credit dedup in `pickActiveRestockCredit` and the ledger-view "corrected via the linked correct-credit op" copy as dead scaffolding. Added `restock.correctCredit`: one `dbTransaction`, gated to the purchaser or pantry-owning household (authz matrix), takes the corrected received count per lot, recomputes the credit as `Σ(receivedCount × unitCostCents)` server-side (never a client dollar figure, D1), REVERSES the old credit (swapped parties, same amount, `reversesId`, same `restockId`) and posts the corrected RESTOCK_CREDIT (also linked) — both survive for the audit trail. Corrects to $0 by reversing with no replacement (invariant 5). Persisting the corrected `receivedCount` is the sanctioned exception to its post-finalize immutability (keeps invariant 5 literally true); it deliberately does NOT touch `remainingCount` — physical drift stays the owner's recount (invariant 9), and double-correcting would desync them. No dedicated UI in v1 (rare, deliberate owner/purchaser action driven via the API); e2e in slice4 builds a cross-household credit and proves reverse→repost→get-active→correct-to-zero on both engines.
- **Rate-limit IP no longer trusts the spoofable left XFF hop (security, major).** `createContext` took `x-forwarded-for`'s LEFTMOST entry — which the client fully controls, since a standard proxy APPENDS the real peer to the right. An attacker got a fresh 30/IP login budget per request → login-throttle bypass → unauthenticated argon2 DoS on the single container. Now derives the client hop from the RIGHT given a trusted-proxy count (`TRUSTED_PROXY_HOPS`, default 1); same fix for `x-forwarded-proto` (the Secure-cookie driver). Added a global concurrency cap on argon2 verification (`verifyPasswordLimited`, `MAX_PASSWORD_VERIFY_CONCURRENCY` default 12 → 429 when saturated) so a login burst can't allocate multiple GB.
- **First-account bootstrap shipped (ops/spec, critical).** A non-demo `docker compose up` booted an empty DB with no way to create user #1 (registration is invite-only; the only creator was the demo seed, "not for production data"). Added `scripts/bootstrap.ts` — creates a household + first pantry + owner with a real argon2id hash, idempotent on household name, refuses to clobber an email — documented in README "Go live". Everyone else still joins by invite.
- **Password reset shipped (ops/spec, major).** PLAN slice-1 claimed "reset via CLI"; no such CLI existed. Added `scripts/set-password.ts` (argon2id rewrite in place), documented in README.
- **TLS / reverse-proxy runbook (ops/spec, major).** README "Go live" now has the missing production recipe: Caddy (auto-TLS) and nginx examples, the required `X-Forwarded-Proto`/`X-Forwarded-For` header wiring (which the Secure cookie and rate-limit IP depend on), `TRUSTED_PROXY_HOPS`, and "don't publish :3000."
- **Compose survives reboots (ops, major).** Added `restart: unless-stopped` to the app service — the healthcheck only flagged unhealthy; nothing acted on it.
- **Leaked API key removed (ops, major).** The live `ANTHROPIC_API_KEY` sitting in the working-tree `.env` was blanked with a rotate-me note; README "Go live" calls out rotating it. *(Superseded 2026-07-03: Aaron intentionally added the key for local live-extraction testing, and `.env` is gitignored — never a commit risk. The key was restored to `.env`. It has been shared in plaintext in-session, so rotating before a real deployment is still prudent, but that is Aaron's call, not a blocker.)*

## Polish round — receiving tweaks (2026-07-03, with Aaron)

Iterating on the built v1 with Aaron in the loop. Five receiving-flow changes he asked for, plus the ranked UX-polish list below. All demonstrated in a real browser (dark mode) and covered by e2e (`e2e/tweaks.spec.ts`, both engines) + unit tests (`src/lib/money.unit.test.ts`). New migration `20260703060000_tax_fees_receipt_text` (data-preserving table rebuild: `Lot.productId` nullable for excluded lines, plus tax/fee/receiptText/allocated columns and `Restock.taxCents/feesCents/feesDistributed/voidedAt`).

- **Lot code up front (reverses D6).** `YYMMDD-NN` is now assigned at draft **start** (`assignRestockCode`, race-safe, re-derived if the receipt date is edited), not at finalize, and shown in a "Label everything" banner from the photos step through reconcile — you pull items from bags in any order and label each as it hits the shelf. Tradeoff: abandoned drafts leave gaps in a day's numbering (fine). Blueprint D6 amended below.
- **Tax & fees as explicit non-inventory amounts (opens D7's door).** Edit-details gains Tax and Fees fields; reconcile is now `receipt − (lines + tax + fees)`, so entering them removes the false "receipt is short" variance instead of forcing an acknowledgment. The variance banner nudges "Add tax or fees →" when a receipt reads short with no tax entered.
- **Proportional distribution → tax-inclusive cost.** At finalize, tax is apportioned across taxable lines (largest-remainder, `apportionCents`), fees across ALL lines only when `feesDistributed` (else the purchaser eats them); both fold into each lot's frozen `unitCostCents` (`allocateReceipt`). So every take and the purchaser credit are truly at-cost — verified end-to-end: $10.00 taxable line + $0.90 tax → unit cost $10.90, cross-household credit $10.90. Per-line **taxable** checkbox; **excluded** ("Non-coop line") toggle for whole receipt lines that aren't inventory (no product/units, counts toward reconcile + fee weight only).
- **Auto-extract + receipt text.** Arriving at Review lines with a receipt photo auto-runs extraction (no button press). Extraction now returns a **clean `description`** (the product name) **and a separate raw `receiptText`** (the line exactly as printed, SKU/tax-flag and all) — the card and edit form show the raw text, the confirmed lot stores it, and the product name stays clean. (Caught during live validation: the first cut folded the raw line into `description`, which doubles as the product name, so a Costco line came back as the product "E 96716 KS ORG EVOO 2L"; fixture mode masked it. Split fixed and re-verified against the real API — clean names, `receiptText` raw.) The printed tax is a **one-tap suggestion** ("Receipt shows $2.87 tax — Add"), never silently written (tax feeds the tax-inclusive cost, so applying it stays explicit — money rule #2). Schema gained top-level `taxCents`, per-line `taxable` + `receiptText`; fixtures/prompt/live-smoke updated. **Live extraction validated end-to-end** against `claude-opus-4-8` (12/12 lines, total matched, ~3¢/11s).
- **Restock history + auditable corrections.** New `/pantries/[id]/restocks` list (drafts resume, finalized/voided open the detail; "History" link on the pantry header). Finalized restocks are never reopened for free edits (that would rewrite frozen unit costs takes already used); instead the detail offers **Correct received counts** (reverse + repost credit via `restock.correctCredit`) and **Void — entered in error** (`restock.voidInError`: reverses the active credit, zeroes `remainingCount`, stamps `voidedAt`; blocked once any take references a lot). Both show the **exact ledger change in a preview before committing** (Aaron's ask). Void stays append-only — the row survives, marked voided.

### Outstanding / next — UX polish (status)

1. **Empty first-run reads as broken (make-or-break).** ✅ Warmed: own-pantry empty state now explains the two-minute receive path with a 🧺 and "Your pantry's empty — for now."; counterparty state reassures it's not broken. (A starter seed at bootstrap remains an option if it still reads thin on a real phone.)
2. **De-jargon the core flows.** ◑ Partial: "FIFO ✓" → "oldest ✓", "it becomes a lot" → "Add each line from your receipt". The take-sheet "Lot" dropdown label and the done-screen "identifies these lots" copy still speak warehouse — a fuller pass is optional.
3. **Copy bugs — space-jamming after inline `</span>`.** ✅ Grep for `</span>` + word boundary is clean; the empty-state sentence was rewritten.
4. **Push toggle can wedge on "Turning on…"** — real-device owner task (10s timeout already in place); unchanged.
5. **Minor mobile 390px ragged wraps** — ◑ pantry header now truncates; the rest are cosmetic, deferred.

Screenshots from this round: `.playwright-mcp/tweaks/verify-*.png` (code banner, tax-reconciled line sheet, tax-inclusive detail, correction preview, void preview, history). The earlier drive is in `.playwright-mcp/usability/`.

**Owner tasks (real-device, can't be done in headless CI):** install the PWA on an iPhone and an Android via the /more card; confirm icon/splash; turn on notifications and confirm a settlement push arrives with the app closed and deep-links to /ledger; scan a real UPC-A barcode in the receive line sheet (torch toggle on Android). Rotate the `ANTHROPIC_API_KEY` and generate real VAPID keys before any public deployment.

## Orders & requests + receiving refinement (2026-07-03, with Aaron)

Second iteration round. Two things: a small receiving-line refinement (Slice A), and a substantial rework of the take flow into **orders with a request/fulfillment lifecycle and inventory reservation** (Slices B–D). Design locked with Aaron before building (his three lifecycle calls + four assumptions below). Notifications are explicitly **out of scope for this round** — see the deferred note at the end.

**2026-07-03 — shipped & green (146 passed + 4 intentional skips, both engines).** Full `down -v && build && SEED_DEMO=1 EXTRACTION_MODE=fixture up --wait && playwright test`. Migration `20260703080000_orders_reserved` (`Lot.reservedCount` + `Order` + `OrderLine`; plain ADD COLUMN, no rebuild).

- **Slice A — receiving Process/Ignore.** `ProposalRow` buttons relabeled Edit→**Process**, Dismiss→**Ignore**; a **matched** proposal keeps one-tap **Confirm**, an **unmatched** one has *no* one-tap path — it must be Processed, where the sheet opens with an empty product picker (autofocused) and Save is blocked until the user picks/creates a product with a real name (the receipt text is shown read-only for reference, never adopted). One line did it: the LineSheet product-state no longer falls back to `{id:null, name: proposal.description}`. `slice5.spec.ts` rewritten to a both-paths `landProposal` helper (deterministic on the shared DB) + a dedicated gating test on a never-created fixture line.
- **Slices B–D — orders.** New `order` router: `addToCart`/`setLine`/`submit`/`startPicking`/`markReady`/`pickup`/`cancel`. Reservation is a guarded read-then-`updateMany` on `remainingCount − reservedCount` (mirrors `adjustment.guardedRecount`, race-safe under the app lock). `pickup` mirrors `take.create` per line (decrements `remainingCount` **and** `reservedCount`, logs a Take, posts the cross-household TAKE ledger entry) under one `dbTransaction` with a `clientKey` + `READY→PICKED_UP` fire-once guard; `cancel` posts nothing. UI: the pantry "Take" became **Add to order** (`AddToOrderSheet`, FIFO lot default), a **cart bar** links to the order, `/orders` lists your orders + incoming requests, `/orders/[id]` is the shared hub whose actions switch on (status × role). New **Orders** tab (5 tabs). Availability everywhere = `remainingCount − reservedCount`.
- **"Everything is a request" → the instant take is gone.** `take.create` was removed (a stand-alone take guarded only on `remainingCount` would oversell units already reserved by an open order). `take.undo` stays as the append-only return path (ledger detail + restock detail). `slice3.spec.ts` deleted; its take/ledger/undo coverage re-homed into `orders.spec.ts` (driven by order pickups). `slice4`/`slice7` migrated off `take.create`/the take sheet.
- **Adversarial review (workflow, 5 dimensions → 19 agents) caught a cross-feature family** — pre-existing inventory ops didn't know about `reservedCount`. Fixed: `adjustment.recount/writeOff` now reject dropping physical stock below `reservedCount`; `restock.voidInError` blocks when open orders reserve its lots; `loadOrderableLot` excludes voided restocks. (Authz reviewer found nothing; `correctCredit` verified safe.) `orders.spec.ts` covers each fix (below-reserved 409, void-blocked 412) plus the full UI lifecycle, ledger-from-pickup + undo, own-pantry $0, and the raw-API guards.

### Slice A — receiving Process / Ignore (no schema, no money)

Extracted-line proposal cards (`ProposalRow`) currently show **Confirm / Edit / Dismiss**, and the one-tap Confirm auto-creates a product from the raw receipt text when nothing matches. Changes Aaron asked for:

- Relabel **Edit → "Process"**, **Dismiss → "Ignore"**.
- **Matched** proposal → keep the one-tap **Confirm** (adds to the matched product), plus Process / Ignore.
- **Unmatched** proposal → **no one-tap confirm**. Only Process / Ignore. Process opens the line sheet where the user must (a) pick/match an existing product *or* create one, and (b) set a real description — prefilled from the receipt text but clearly meant to be rewritten, since receipt descriptions are often unusable. No silent auto-create of a product from receipt text.

### Slices B–D — orders + requests (schema + money)

**Decisions locked (Aaron):** every order goes through the request/fulfillment flow (no instant-take path); the ledger posts **at pickup**; and the states are explicit with a separate "start picking" lock.

**Unified lifecycle (one Order object per pantry, built by a household):**

```text
DRAFT       building the cart; NOT reserved
 → REQUESTED  submit: reserve inventory (guard: available ≥ qty); requester may still edit
 → PICKING    owner "starts picking": edits LOCK
 → READY      owner "ready to pick up"
 → PICKED_UP  Takes created + TAKE ledger entries post here (cross-household only; $0 own-pantry)
 → CANCELED   (from DRAFT / REQUESTED only) release reservations; ledger never touched
```

Post-pickup returns reuse the existing `take.undo` (swapped-party REVERSAL + inventory restore) — unchanged.

**Data-model deltas:**

- `Lot.reservedCount Int @default(0)` — availability everywhere becomes `remainingCount − reservedCount`. Reserve guards on it; pickup decrements `remainingCount` **and** `reservedCount` together, so a `Take` stays exactly what it is today (the record of a real decrement + ledger post).
- `Order` — `pantryId`, `requesterHouseholdId`, `createdById`, `status`, lifecycle timestamps, optional note.
- `OrderLine` — `orderId`, `lotId`, `quantity`, `takeId?` (set at pickup).

**Money invariants preserved:** every reserve/edit/pickup/cancel goes through `dbTransaction`; the pickup mutation carries a `clientKey`; the ledger stays append-only (TAKE at pickup, REVERSAL on return, **nothing** on cancel — money never posted before pickup). Reservation is a soft hold that never touches the ledger.

**Assumptions Aaron confirmed:**

1. **Lot-specific lines** — the requester picks a lot (FIFO default, like today's take sheet), not "product, owner picks the lot." Keeps at-cost precision trivial.
2. **One open DRAFT order per (household, pantry)** — adding items accumulates into it; two drafts racing for the last unit is fine (first to submit reserves; the second gets "not enough available").
3. **The browse-and-take page becomes an ordering surface** — "Take" → "Add to order" + a cart; there is no more one-tap immediate take. Own-pantry orders run the full flow too (you are requester and owner both; $0).
4. **Push/notifications deferred** (below).

**Slice plan:**

- **A** — receiving Process / Ignore (independent, ships first with its own browser + e2e verify).
- **B** — orders engine: migration (`reservedCount` + `Order` + `OrderLine`) + reservation + full lifecycle mutations (`order` router), unit + e2e.
- **C** — requester UI: cart → request → edit/cancel/pickup.
- **D** — owner fulfillment UI: incoming requests → start picking → ready → picked up.

### Deferred: notifications (its own future round)

Aaron: notifications are a **separate feature set** to work through later, because there's real depth — **push infra, email infra, an in-app notification panel, event generation, and per-user notification prefs**. This round ships in-app order status only (the requester sees status on their orders; the owner sees incoming requests). The natural order events (request placed → owner; ready → requester; picked up) become notification triggers when that round happens. The existing slice-7 push (settlement + adjustment only) stays as-is until then.

## Mutual-aid rework — "Potluck" (design locked 2026-07-03)

Aaron initiated a rebrand/reorg toward mutual aid: households become nodes in an emergent
network of pairwise connections (multi-household instances; future federation between
instances), plus needs/surpluses sharing, a recipe book, and Plan-to-Eat-style meal
planning + shopping lists integrated with cross-network pantry orders.

**The full design interview record and implementation seed is
[docs/REWORK.md](./docs/REWORK.md)** — every decision (DECIDED by Aaron or ASSUMED
veto-able), the drafted capability/grant vocabularies, and the round plan. Supporting
research: [docs/research/plan-to-eat.md](./docs/research/plan-to-eat.md) and
[docs/research/federation.md](./docs/research/federation.md).

Headline decisions: full multi-membership with per-household capability flags (RBAC-lite,
roles as presets) · connections carry **directional** grants each side controls
unilaterally · per-pantry/item shared flags · **orders = at-cost, shares = gifts** (posts
never touch the ledger; tracked handoffs record $0 transfers) · claims are
signal+confirm with optional quantities; reshares chain hop-by-hop with the resharer
brokering (people only interact with direct connections) · per-household products ·
username identity (`user@instance`-ready) + required email · edge-growth onboarding
(new-household invite = first connection) with instance-admin toggle · federation
deferred with a declared custom Coop↔Coop protocol target (only the cheap groundwork
ships now) · recipes browse-live/fork-on-save over a recipe grant with a learned
per-household ingredient→product mapping · shopping list never silently removes items
(PTE's pantry lesson) · rename to **Potluck** · evolve in place, four rounds:
**network core → needs/surpluses → recipes → planner/shopping**.

Implementation began 2026-07-03 (overnight autonomous session, Aaron's handoff). Round 1
progress below, newest first.

### Round 1 slice 3 — connection management UI + shared flags

**2026-07-03 — done.** Connections are now self-service: request/accept/sever by
household handle with directional grant editing (B1/B2/B6), plus the B3 shared/private
flags on pantries and items. Gate: fresh `down -v` stack, **167 passed + 4 intentional
skips, both engines, playwright exit 0** (one known-pattern webkit first-goto flake,
retry-passed), after a real-browser drive of the connections card
(`.playwright-mcp/network-core/s3-connections-card.png`).

- **`connection` router.** `list` (any-status edges normalized to
  weGrant/theyGrant) · `request` (by slug — B5's exact-handle rule, no discovery;
  PENDING edge carrying OUR grant set; SEVERED pairs re-requestable with both sets
  reset; self/unknown/duplicate → 400/404/409) · `respond` (addressee-only;
  accept sets OUR grants + ACTIVE; decline deletes the row) · `setGrants`
  (unilateral, PENDING or ACTIVE) · `sever` (PENDING = withdraw/delete; ACTIVE →
  SEVERED **with B6 fallout in the same transaction: REQUESTED/PICKING/READY orders
  across the pair auto-cancel and release their reservations**; loans run to return;
  ledger/net survive). All manageConnections-gated.
- **Grant presets** (B2 "levels", `GRANT_PRESETS` in authz.ts): Neighbor =
  shareTo/shareFrom · Friend = + pantry/lending/recipes · Family = everything +
  reshare.
- **UI.** /more gains the Connections card (status pills, incoming
  accept-with-preset/decline, expandable my-side grant editor with preset chips,
  sever/withdraw with confirm) and the household card now shows YOUR handle
  (`@heise — share it so other households can connect`). Pantry header gets a
  shared/private chip (owner + manageHousehold; History link is now owner-only —
  the page has been owner-only since S2); the item edit sheet gets a
  "Shared with connections" checkbox (flag changes manageHousehold-gated on top of
  lendBorrow; `pantry.setShared` is a new router). Severed pairs with a nonzero net
  keep a net strip on `/` (their only /ledger entry point — closes an S2 review
  note).
- **e2e (`connections.spec.ts`,** 4 tests × 2 engines): the full lifecycle runs
  against an EPHEMERAL fourth household through the slice6 container seam (the
  seeded 3-household topology is load-bearing for other specs; household creation
  gets a product surface in R1S4) — request by handle → directional accept (Neighbor
  back = no pantry visibility despite ACTIVE edge) → unilateral grant edit flips
  Fern's scope live → sever auto-cancels her REQUESTED order, releases the
  reservation, blocks new ordering (404), keeps the balance settleable, and allows
  re-request; private-pantry and private-item round-trips (visible → hidden → 404 →
  restored) with capability 403s (Teen) and non-member 404s.
- **Two suite-health fixes this round:** (a) `openPantryOf`'s render sentinel was
  the History link — now owner-only, so foreign-pantry opens hung; sentinel is the
  always-present back link. The failed-mid-flow runs this caused left poisoned DRAFT
  carts (ONE cart per household+pantry, shared across runs) whose stale lines 409'd
  every later submit — orders.spec now starts every cart flow with a `freshCart`
  cancel, so a dead run can't poison the next. (b) **Gate invocations were piping
  playwright through `tail`, masking its exit code** — one "green" run actually had
  6 chromium failures. Gates now echo `PLAYWRIGHT_EXIT` explicitly; both fixes
  re-proven on the fresh stack above.
- Login helper now signs out and returns when an authenticated page bounces off
  /login (the third test to trip that; fixed once in helpers.ts).

### Round 1 slice 2 — authz/capability layer, acting household, username login

**2026-07-03 — done.** The network core now BEHAVES like a network: every mutation and
read is gated by membership capabilities (A3a) × connection grants (B2) × shared flags
(B3), the sticky acting-household switcher works end-to-end, and login is
username-or-email. Full gate: fresh `down -v && build && SEED_DEMO=1
EXTRACTION_MODE=fixture up --wait && npx playwright test` — **157 passed + 4 intentional
skips, both engines** (one known-pattern webkit browser-age flake, retry-passed), after
a real-browser drive of the switcher (Marie: Heise ⇄ Neighbors, screenshots
`s2-switcher-heise.png` / `s2-switched-neighbors.png`).

- **Authz core (`src/server/authz.ts`).** `requireCapability(user, cap)` (typed test on
  the ACTING membership → 403), `hasActiveGrant(granter, grantee, grant)` (directional,
  ACTIVE connections only), `activeConnectionsOf` (page scoping), and
  `loadAccessiblePantry`. Error convention: capability failures on visible things are
  403; visibility failures (no grant / not shared / no connection) are 404 — existence
  never leaks.
- **Capability map shipped** (every procedure): invites → `manageHousehold` · receiving
  (create/all draft edits/extract) → pantry-OWNER household + `receiveStock`, with the
  PURCHASER constrained to the acting household or an ACTIVELY-connected one (was free
  client input!); finalize keeps creator/purchaser standing, adds owner-household ·
  orders → `placeOrders` drafts/edits/cancels, cross-household submit adds `spend`,
  owner side (`startPicking`/`markReady`/decline) → `fulfill`, pickup needs
  requester-`spend`(cross)/`placeOrders`(own) OR owner-`fulfill` · `take.undo` →
  `placeOrders` in the take's snapshot household · lending → `lendBorrow`, cross
  checkout adds `Item.shared` + lending grant + `spend` when fee > 0 ·
  recount/write-off → `adjustInventory` · settle/adjust/correctCredit/voidInError →
  `settleMoney` (settle deliberately needs NO active connection — B6 lets severed pairs
  settle) · `product.search` → acting household's catalog only.
- **Read scoping** (B4 replaces "everyone sees everything"): `/` shows own pantries +
  pantry-granted connections' SHARED pantries, net strips for every connected
  counterparty; `/pantries/[id]`, `/restocks/[id]`, `/items/[id]` gained view gates;
  `/pantries/[id]/restocks` is owner-only (the books); `/ledger` counterparties come
  from connection rows in ANY status (severed pairs keep their history); `/items`
  scopes by lending grant + shared; `/more` and `household.overview` list acting +
  ACTIVE-connected households (pantries filtered by grant+shared).
- **Acting household (A3b).** `auth.setActingHousehold` validates the target against
  live memberships and sets the year-long `coop_household` cookie; the /more "Acting
  as" card renders only for multi-membership users and full-reloads on switch (the
  module-singleton query cache must die). Single-membership users never see it.
- **Username login (A2).** `auth.login` takes `identifier` (username or email — '@'
  disambiguates; both unique; DUMMY_HASH timing mask now covers username enumeration);
  rate-limit keys moved to `login:id:`; error copy "Invalid username or password.";
  registration collects an explicit username (charset-validated, conflict → 409).
- **Demo seed grew the network (D3):** third household Neighbors (Nia, Owner; pantry
  "Garage Shelves"), Heise↔Neighbors ACTIVE **share-only** (no pantry/lending grants —
  the visible-but-not-browsable edge), In-Laws↔Neighbors **unconnected**, Marie gains
  an ADULT membership in Neighbors (the switcher fixture; created second so Heise stays
  her default), and Theo (TEEN preset) joins Heise for capability-denial coverage.
- **e2e.** New shared `e2e/helpers.ts` (login by 'Username or email', apiLogin posting
  `{identifier}`) replacing 8 duplicated copies (subagent-built); new
  `e2e/network.spec.ts` (5 tests × 2 engines): switcher re-scoping + stickiness +
  absence for single-membership users, Nia's scoped world (no In-Laws anywhere, Heise
  visible but pantry-less, 404 ordering probe vs Dana's 200), Teen draft-yes/submit-403
  + settle/adjust/recount/invite 403s + hidden invite affordance, receiving-as-owner
  403 for a fully-granted counterparty + purchaser-attribution 200(connected)/404(bogus).
  slice1 asserts the scoped counts (2 pantry groups, 2 net strips, 3 /more cards) and
  the new login tests; slice4's single-net-strip reads became name-filtered.
- **Adversarial review (workflow, 3 lenses × high/xhigh) → fix round before commit.**
  22 findings (0 critical, 8 major); every real hole closed and re-proven:
  `ledger.settle/adjust/markSeen` now require a connection edge in ANY status (a
  settleMoney holder could previously post money + push-spam against ANY household id
  in the instance — unconnected pairs also wedged an uncleanable "new" dot; 404 keeps
  ids unprobeable while B6's severed-pair settlement still works) · `order.setLine` on
  a REQUESTED cross-household order now needs `spend` (a placeOrders-only teen could
  inflate an approved order past what the spend-holder submitted) · `order.pickup`
  re-verifies the pantry grant at the MONEY moment (grant revoked/severed while READY
  → 409 "cancel instead"; cancel deliberately stays grant-free so reservations always
  release) · `restock.finalize` re-verifies the purchaser connection is ACTIVE before
  posting the credit, and the finalize/removeImage/deleteDraft gate became
  acting-owner-household + receiveStock (`assertOwnerReceiving`) — the old
  bare-creator standing let a user demoted in the owner household finalize on a
  capability from an UNRELATED household's membership, and purchaser-side finalize
  let a teen post a credit in their own household's favor; the purchaser now reads
  its credit on the restock detail (the wizard shell redirects non-owners there,
  fixing the stranded-purchaser-draft dead cockpit) · the restock detail no longer
  leaks a household's books to pantry-granted third households (non-party viewers get
  the inventory story only: no credit/receipt images/totals/purchaser/adjustments,
  takes filtered to their own household's) · draft probes by outsiders read 404
  before any status distinction · fee-bearing `item.create`/fee edits need
  `settleMoney` on top of lendBorrow (teens could unilaterally price future
  cross-household income) · login gained a per-ACCOUNT rate bucket (username+email
  would otherwise double the guessing budget) · `markSeen` echoes the rendering
  household so a stale tab surviving a household switch no-ops instead of marking
  the wrong membership's entries seen · EditDetailsSheet unions the draft's current
  purchaser into its picker and the server always allows KEEPING it (only CHANGES
  need an active connection — finalize re-checks at money time). e2e grew the
  unconnected-pair money probe (Marie acting as Neighbors vs In-Laws → 404) and the
  submitted-order inflation probe (Theo setLine → 403); slice2's gate test now
  asserts the 404 convention. Final gate re-run: **159 passed + 4 skips, both
  engines.**
- **Known S3 polish gaps (deliberate):** UI affordances are not yet capability-hidden
  everywhere (a Child-preset member would see a Receive FAB that 403s; Teen sees
  lot-menu recount / order-fulfillment buttons that 403); severed-pair net strips
  lose their /ledger entry point once severing exists (render any-status strips with
  nonzero net, or give /ledger a pair picker); acceptInvite still mints Owner-preset
  memberships (invite-carried presets are R1S4); loan.checkout's replay lookup runs
  before the cross-household spend check (harmless; convention documented in
  authz.ts).

### Round 1 slice 1 — schema + data migration (network core)

**2026-07-03 — done.** Migration `20260703100000_network_core` + the compatibility shim;
the app behaves identically to pre-rework for the existing two-household world. Proven
twice: (a) **data-preserving path (J2)** — the dev volume's real accumulated DB (7 users,
89 products, 26 takes, 18 loans, 76 ledger entries) migrated in place and the full
Playwright suite ran green against it (146 passed + 4 intentional skips, both engines);
(b) **fresh path** — `down -v && build && SEED_DEMO=1 EXTRACTION_MODE=fixture up --wait
&& npx playwright test`, same result. Schema↔migration parity held by
`prisma migrate diff --from-migrations --to-schema` (clean).

What changed:

- **Schema.** `Membership` (user↔household + 11 capability booleans; REWORK's `order`
  flag shipped as `placeOrders` — SQL-keyword/Order-model collision) replaces
  `User.householdId`; `Connection` (canonical ordered pair `householdAId <
  householdBId`, status PENDING/ACTIVE/SEVERED, 12 directional grant booleans
  `aGrants*`/`bGrants*`); `User.username` + `Household.slug` (unique, `[a-z0-9_-]`);
  `User.isInstanceAdmin`; `InstanceSettings` singleton (`id='instance'`,
  `allowMemberHouseholdInvites`); `Product.householdId` (owner = the household whose
  PANTRY holds its lots — never the purchaser); `Pantry.shared`/`Item.shared` (default
  true); **attribution snapshots** `Take.householdId` (stamped at pickup from
  `Order.householdId`) and `Loan.borrowerHouseholdId` (stamped at checkout) — relation-
  free like LedgerEntry, so money/undo authz never re-derives a household from a user's
  (now-mutable) memberships; `LedgerSeen` re-keyed `(userId, ownHouseholdId,
  counterpartyHouseholdId)`.
- **Data migration.** Owner-preset memberships for every user; ACTIVE full-grant
  connection per existing household pair; usernames from email local-parts and slugs
  from names (charset-guarded via GLOB fallback to id-based handles; duplicates
  suffixed with the row's own id — an earlier rank-suffix design was killed by
  adversarial review: correlated ROW_NUMBER re-evaluates mid-UPDATE and 3-way
  collisions abort the migration half-applied, plus rank suffixes collide with
  pre-existing `-2` names); first user = instance admin; products duplicated per
  additional household using them (`p-<hh>-<id>`), each lot re-pointed to its own
  pantry-household's copy; orphan (lot-less) products deliberately DELETED rather than
  misassigned — the one lossy step, documented in the migration header. Table rebuilds
  (User, Household, Product, Take, Loan, LedgerSeen) follow the proven
  `tax_fees_receipt_text` pragma dance; `Loan_one_active_per_item` partial index
  recreated by hand (Prisma can't express it).
- **Compatibility shim.** `getSessionUser()` now loads memberships and resolves the
  ACTING household: `coop_household` cookie validated against memberships, else first
  membership (`createdAt, id` tiebreak — backfilled rows share one timestamp second).
  It returns `{...user, memberships, householdId, household, activeMembership}` so all
  ~56 pre-rework `user.householdId`/`user.household` consumers (tRPC ctx AND the
  direct-Prisma server pages) keep working against the acting context. Nothing writes
  the cookie yet — that's the S2 switcher.
- **Code deltas.** `take.undo`/ledger/restock-detail `canUndo` read `take.householdId`;
  loan return/undo gates read `loan.borrowerHouseholdId` (checkout replay also
  validates it); `order.pickup` stamps `Take.householdId`; `restock.saveLine` creates
  products under the pantry-owner household AND rejects picking another household's
  product (the UPC write-through could stamp a foreign catalog — closed per review);
  push fan-out is Membership-based with per-user dedupe; `household.overview` and
  `/more` map memberships to the identical members shape; seed gains
  usernames/slugs/memberships/connection/settings/admin (idempotent against both fresh
  and migrated DBs — verified byte-equivalent); bootstrap creates
  settings + slug + username + Owner membership + first-user-admin in one transaction;
  new `src/server/capabilities.ts` (typed capability vocabulary + Owner/Adult/Teen/
  Child presets) and `src/server/identity.ts` (handle derivation, 14 unit tests).
  e2e: only slice6's raw-SQL seam changed (Membership insert, slug/username columns,
  Connection cleanup).
- **Adversarial review (workflow, 3 lenses × xhigh)** found the dedupe-abort family
  (fixed above), the saveLine cross-household product hazard (fixed), the slice6
  Connection-cleanup FK trap (fixed), bootstrap's non-transactional user+membership
  (fixed), and the ordering nondeterminism (fixed). Migration equivalence re-proven
  after fixes: real-data output byte-identical minus CURRENT_TIMESTAMP columns;
  pathological worlds (3× same name, adjacent `-2`, punctuation-only, 2-char locals)
  all migrate to unique charset-clean handles. `prisma migrate deploy` verified to NOT
  re-validate checksums of applied migrations (edited-file safety).

**S2 checklist recorded by review (money gates that silently re-key to the acting
household the moment multi-membership lands — each needs its capability pairing):**
`ledger.settle/adjust` `assertPairWithMe` → `settleMoney`; `restock.finalize`
`assertMayFinalize` → `receiveStock`(+`spend`?); `restock.correctCredit`/`voidInError`
gates → `settleMoney`; `take.undo` → `placeOrders`/`spend`; `order.pickup` standing →
`spend`/`fulfill`; `loan.checkout` → `lendBorrow`+`spend` (checkout sheet must SHOW the
acting household that will owe the fee); `restock.create` purchaser attribution must be
constrained to households the actor holds a membership in (today it's free client
input); `product.search` must scope to the pantry-owner household; carts are
per-(pantry, acting-household). Also deferred: `/api/images` serving is session-only
(any member fetches any image) — decide connection-scoping deliberately.

## Progress notes

Append dated notes per slice as work happens: decisions made, deviations from spec (with why), what was demonstrated and how. Newest at the top of each slice's section.

### Slice 1 — Skeleton

**2026-07-02 — field bug fixed.** Aaron couldn't log in from his own browser: the session cookie was marked `Secure` whenever `NODE_ENV=production`, and Safari refuses `Secure` cookies over plain http — localhost included (Chromium exempts localhost, which is why e2e and the manual drive missed it; any browser hitting a LAN IP over http drops it too). Fix: the cookie's `Secure` flag now follows the actual request protocol (`x-forwarded-proto` first hop, else the request URL scheme), so it hardens automatically once TLS is in front. Regression coverage: a `webkit` project joined the Playwright matrix (12 tests = 6 × chromium/webkit); reproduced the failure on WebKit before the fix, green after. Lesson for future slices: verify on both engines — the families use iPhones and Androids.

**2026-07-02 — done.** Next.js 16 (Turbopack) + tRPC 11 (`@trpc/tanstack-react-query`) + Prisma 7 + SQLite, single `node:22-slim` container; entrypoint runs `prisma migrate deploy` and seeds demo fixtures when `SEED_DEMO=1`. Auth is hand-rolled per SPEC §6: argon2id (OWASP params), 30-day sliding sessions stored as sha256 hashes with the raw token only in an httpOnly cookie, in-memory login rate limiting (10/email, 30/IP per 15 min), timing-equalized login errors, and single-use 7-day invite tokens (hashed at rest, raw only in the shared link). Dashboard is a server component reading Prisma directly; mutations go through tRPC.

Verified: 6 Playwright tests green against the freshly-seeded compose stack (`SEED_DEMO=1 docker compose up -d --wait && npm run e2e`), plus a manual browser drive with probes: wrong password, tampered invite token, invite reuse, already-signed-in invite guard, sign-out. Prisma 7 notes for future slices: no `url` in schema datasource (lives in `prisma.config.ts`), driver adapter required (`@prisma/adapter-better-sqlite3`), `prisma generate` is manual, Dockerfile needs a build-time `DATABASE_URL`.

Deferred deliberately: production deployment (reverse proxy + TLS) until we actually host it; password reset (invite a re-registration or reset via CLI for now — revisit before friends join); household/pantry management UI (seeded via fixtures; real households get created at deploy time).

### Slice 2 — Receiving

**2026-07-02 — code-review fixes (behavior changes).** A review pass on the uncommitted slice confirmed one critical and several major findings; all fixed and re-proven end-to-end:

- **DB serialization (critical):** the better-sqlite3 driver adapter takes its mutex only for transactions, so a concurrent plain query could execute *inside* another request's open interactive transaction and vanish with its rollback (finalize rolls back by design on the D6 seq retry). `src/server/db.ts` now serializes every operation through one app-level lock; interactive transactions go through the new `dbTransaction()` helper, which holds the lock for their whole duration (never call `db.$transaction` directly). Verified with a live reproduction: a concurrent write now survives a rolled-back transaction.
- **Check-then-act on DRAFT status:** `updateDraft`/`saveLine`/`deleteLine`/`removeImage`/`deleteDraft` now do their status check and write inside one `dbTransaction`, so a concurrent finalize can no longer let them mutate/destroy a FINALIZED restock (posted credit vs. deleted lots, null-unit-cost lots, unlinked permanent receipt files). Position assignment (images, lots) and inline product creation moved into the same transactions — no more P2002 races or orphan `Product` rows.
- **Image path forgery:** `addImage`/`setUnitPhoto` accepted any string and deleted whatever the old path pointed at — any member could destroy another restock's permanent receipt files. Attach mutations now require a fresh, server-named upload of the right kind (`isStoredImagePath`), present on disk and referenced by no other row; file unlinks happen only after DB commit and only when unreferenced. `removeImage` is now gated like `deleteDraft` (creator or purchaser household).
- **D7 consent gate:** the client no longer auto-sends the acknowledgment. Finalize outside the auto-pass window is a real two-tap confirm ("Finalize" → "Finalize anyway — receipt differs by $X"), and the client *echoes the variance it displayed*; the server rejects a missing or stale echo (`acknowledgedVarianceCents` must equal the recomputed variance), so nobody can "acknowledge" a number they never saw.
- **Header now editable after step 1:** `updateDraft` was dead code; an "Edit details" affordance (retailer/date/purchaser/receipt total) is visible on every draft step, so a typoed total or date no longer forces finalize-wrong-or-abandon.
- **Misc:** start-sheet date defaults to the *local* calendar date (was UTC — evening sessions got tomorrow's D6 code); resume banner only shows drafts the viewer can finalize, and a failed abandon now surfaces its error; upload route enforces Content-Length before buffering, plus a per-user rate limit (120/15 min); `dateOnly` rejects impossible dates and cents inputs are capped at $1M; RESTOCK_CREDIT display reads go through `getActiveRestockCredit` (ignores reversed credits, ready for the slice-4 correct-credit op); orphaned image files are swept at server boot (`src/instrumentation.ts`, 24 h grace); successful logins reset the per-IP budget too, so only failures count toward spraying limits.
- **e2e:** suite grew 13 → 26 (× chromium/webkit): server-side variance-guard rejection (412), finalize/abandon authz (403 for an unrelated member), unauthenticated image/upload access (401), traversal (400), non-JPEG and bad-kind uploads (415/400), forged attach path (400), line edit/delete, receipt-photo removal (file provably gone from disk), removeImage-after-finalize (412), and the edit-details flow. Test data now carries a per-run token, and the suite is green run twice against the same live stack (previously required a `down -v` reseed).

**2026-07-02 — done.** Shipped the receiving vertical per blueprint 01/02/03/04: `slice2_receiving` migration (Product, Restock, RestockImage, Lot — line = lot, D4), image pipeline (client canvas downscale → multipart upload route → authenticated `/api/images` serving, files under `IMAGES_DIR` on the existing volume), the full wizard (start sheet → receipt photos → line review with inline product create, hold-backs, running reconcile banner → unit photos → reconcile/finalize → big-code done screen), pantry inventory grouped by product with FIFO-ordered lot rows and best-by amber/red badges, restock detail (`/restocks/[id]`), the 4-tab shell (Ledger/Items greyed), and the design-system token migration (blueprint 03 `globals.css` verbatim; all slice-1 screens retargeted; `git grep` palette guard is clean). Finalize is one transaction: half-up unit costs frozen (D1), `remainingCount` set, variance stored (D7, explicit acknowledge outside the 2¢/line window), purchaser credit posted for cross-household restocks, code assigned race-safely via `@@unique([dateCode, seq])` + P2002 retry (D6).

Verified: 18 Playwright tests green (9 × chromium-light / webkit-dark) against a fresh `docker compose down -v && build && SEED_DEMO=1 up --wait` stack — full wizard incl. hold-back line, image upload round-trip, cross-household credit at `count × unitCost` ($10.00 line / 3 units → $9.99 credit, proving D1), draft resume after reload + abandon, plus the retrofitted slice-1 suite. Dark mode spot-checked via webkit screenshots.

Deviations from blueprint, with reasons:

- **`LedgerEntry` pulled into the slice-2 migration** (planned for slice 3): finalize must post the purchaser credit (01 D1/invariant 5, 02 step 5); deferring the table would have finalized cross-household restocks with no credit to backfill. Takes still arrive in slice 3; the model is relation-free exactly as 01 specs it.
- **Step-4 "existing product photo beside the card" comparison omitted** — no prior photos exist until products recur; the card shows the lot's own photo/placeholder. Revisit when a real repeat-purchase happens.
- **Best-by input is a native `<input type="date">`** rather than the sketched `mm/yy` field — free mobile pickers, no parsing code.
- Recent-retailer chips (step 1) skipped for now — plain text field; cheap to add once there's history to chip.
- e2e uses 1×1 JPEG fixtures rather than 50–100KB photos — the pipeline (magic-byte check, downscale, round-trip) is what's under test.

Field bug found by e2e: the slice-1 login helper's `getByText('your household')` also matches the login footer ("…a member of your household…"), so a follow-up `goto()` raced and aborted the in-flight login mutation. Helpers now wait for the URL + tab bar. Also fixed a pre-existing `react-hooks/purity` lint error on the invite page (`Date.now()` during render → moved into a loader).

### Slice 3 — Takes & ledger

**2026-07-02 — code-review fixes (behavior changes).** A review pass on the uncommitted slice confirmed seven findings; all fixed and re-proven end-to-end:

- **Ledger dates were UTC:** rows and the expanded detail rendered `createdAt.toISOString()` calendar dates, so any entry after ~6–7pm US time displayed tomorrow's date (the exact bug class fixed for the slice-2 start-sheet). Both now format from local date getters in the client component.
- **Negative net lost its color:** the hero, the home net strip, and negative row amounts rendered "down" in plain `text-text` (and the hero's $0 in muted), against blueprint 03 §3's contract (success up / danger down / text at $0). All three now use `text-danger` when down.
- **Own-household takes had no undo after the 10s toast** (they post no ledger row, so the ledger-detail undo never applies). The restock detail now lists the restock's takes newest-first — who/qty/product/date, "no charge" or cost, "undone" badge — with Undo for the viewer's household's active takes; pantry lot rows link their code to the restock detail, so the path is reachable from inventory. This supersedes the earlier "undoable only from the toast" deviation note below; slice-4 recounts remain the drift fixer.
- **take.create double-submit guard:** `disabled={isPending}` re-renders asynchronously, so a fast double-tap could commit two takes (the first invisible/unrecoverable for own-household takes). New `slice3_take_client_key` migration adds `Take.clientKey` (nullable, unique); the take sheet sends one key per open and the server returns the original take on a replay instead of decrementing again (check-then-act is safe under the app-wide DB lock). No key → old behavior (keys are optional).
- **e2e:** suite grew 17 → 20 per engine (40 total): sheet-level 409 surfacing (stock yanked while the sheet is open → `Not enough left.` alert, sheet stays open), stale-toast undo error (`Already undone.` shown in the toast; toast now exposes `data-take-id` for out-of-band undo), restock-detail take history + undo restoring inventory, invalid quantities (0 / −1 / 1.5 → 400), clientKey replay returning the same takeId with a single decrement, home net strip matching the hero before and after a real credit (sign-flip canary), `?with=` resolution incl. unknown-id fallback, and the Credits/Takes chip filtering a RESTOCK_CREDIT row. Green twice in a row against one live stack. Still untestable with the 2-household seed: the >2-household pair picker.

**2026-07-02 — done.** Shipped takes and the ledger per blueprint 01/02: `slice3_takes` migration (just `Take` — `LedgerEntry` was pulled forward in slice 2), `take.create`/`take.undo` tRPC mutations exactly per the 01 canonical snippets (conditional-decrement stock guard limited to FINALIZED restocks; own-household takes log with `costCents: 0` and no ledger entry; undo gated to the taking household, `reversedAt` one-way guard, swapped-party REVERSAL with `reversesId`, units restored in the same `dbTransaction`). UI: product-row tap in pantry inventory now opens the take sheet (lots expand via a chevron-only affordance, per blueprint — the slice-2 e2e was updated for this); oldest lot preselected with a `FIFO ✓` badge and overridable via dropdown; qty stepper blocks overtake; cost line reads "You'll owe {owner} $X" or "No charge — your pantry"; success shows a 10s Undo toast. `/ledger` is a server component (slice-1 convention) with the net-position hero ("You're up/down $X with {household}"), All/Takes/Credits/Payments chips, newest-first rows enriched by hand (LedgerEntry is relation-free) with inline-expanding detail (creator, note, View-restock link, Undo for the taking household). Pantries tab gets a per-counterparty net strip linking to `/ledger`; the Ledger tab is enabled.

Verified: 34 Playwright tests green (17 × chromium-light / webkit-dark) against a fresh `docker compose down -v && build && SEED_DEMO=1 up --wait` stack, then three more consecutive green full-suite runs against the same live stack (rerun-safe: all net-position assertions are deltas against a value read before acting — the shared DB accumulates across projects and runs). Covered: cross-household take at `qty × unitCost` ($10.00/3 → 2 × $3.33 = $6.66, D1 exactness), both households' hero/rows showing ±$6.66, undo-from-ledger posting a `+$6.66` REVERSAL while the original row stays (append-only) and inventory returns, own-pantry no-charge take with no ledger entry plus toast-undo, FIFO preselect across two restocks with override dropping the badge, and raw-API guards (overtake 409, foreign undo 403, double undo 409, DRAFT-lot take 409). Dark mode spot-checked by screenshot (ledger hero/chips/signed amounts, take sheet, net strip).

Decisions/deviations, with reasons:

- **No "Edit" affordance on takes** — blueprint D2 defines edit as undo + new take in one transaction; the shipped Undo (toast + ledger detail) plus taking again covers the need with zero extra code. Revisit if it ever grates.
- **Own-household takes are undoable only from the 10s toast** — they post no ledger entry, so there's no ledger row to undo from. The slice-4 recount is the correction path afterwards (owner-gated, same household).
- **Ledger rows expand inline** rather than navigating to a dedicated entry screen — same information (who/what/note/restock link/undo), one less route; "each row → detail" read as an interaction, not a page.
- **"Settle up" button ships disabled** with an "arrives in slice 4" tooltip, mirroring the greyed-tab pattern.
- Pair picker renders only when >2 households (blueprint); the pair is addressable via `/ledger?with=<householdId>` (the net strip links use it).
- Net math is a JS fold over the pair's entries (`netByCounterparty` in `src/server/ledger.ts`) instead of 01's raw SQL — identical result, no `$queryRaw` bypassing the app-level DB lock's typed surface, trivial at 2–10 households.

Field bug found by e2e: **product search staleness** — `product.search` results are cached 30s (React Query `staleTime`), so a product created while saving a line stayed invisible to the picker for the next line/restock in the same session (masked before because full-page `goto()`s reset the cache; exposed when tests switched to client-side tab navigation). Fixed: `saveLine` success invalidates `product.search`. Also hardened e2e against three real races: wizard steps all have a "Next" button, so a fast second click lands on the previous step's still-mounted button (now every Next waits for the next step's heading); `page.goto()` issued while an RSC navigation/refresh is in flight makes Next fall back to a full-page load that interrupts the goto (helpers now navigate via the tab bar and wait for content); and Playwright `hasText` string filters are case-insensitive, so "Take 2× …" also matched "Undo take 2× …" rows (case-sensitive regex).

### Slice 4 — Settlements & adjustments

**2026-07-02 — code-review fixes (behavior changes).** A review pass on the uncommitted slice confirmed thirteen findings; all fixed and re-proven end-to-end:

- **settle/adjust/writeOff idempotency (money):** all three were bare creates guarded only by `disabled={isPending}` — the exact double-tap/lost-response failure slice 3 closed for takes. `clientKey` (nullable, unique) added to `LedgerEntry` and `Adjustment` (folded into the still-uncommitted `slice4_adjustments` migration); every sheet (settle, adjust, recount, write-off) now sends one key per open (helper moved to `src/lib/client-key.ts`) and the server replays the original result instead of double-posting a settlement/adjustment or double-decrementing a write-off. Cross-type/foreign-user key reuse fails closed (409). e2e proves one entry + one decrement across replays for all three.
- **"New" markers rebuilt on a per-pair, per-user watermark:** `User.ledgerSeenAt` (one user-wide stamp, written as mutation-time `now()`) replaced by a `LedgerSeen` table keyed `(userId, counterpartyHouseholdId)`. `markSeen` now takes the pair plus the page's **render** timestamp (server-generated, echoed back, clamped to the server clock, monotonic) — entries created in the render→markSeen window were never on screen and stay flagged, and with >2 households viewing pair A–C can no longer swallow pair A–B's unseen entries.
- **Settlements now flagged for the recording household's other members (spec):** blueprint 02/SPEC §5 say BOTH households see a settlement flagged "new"; the old `hasNew`/`isNew` excluded the whole creating household. Both now exclude only the creating USER (uniformly, for every entry type — the dot means "your ledger changed and you haven't looked"). Seed gained a second Heise member (`marie@demo.coop`) and the settle e2e asserts Marie gets the dot + row highlight for Aaron's settlement.
- **Lot ⋯ menu grew the promised photo path (spec):** the wizard's skip copy says "You can add photos later", and blueprint 02 puts that in the lot ⋯ menu — which had no such action. Added "Add/Replace unit photo" (upload → `restock.setUnitPhoto`, which was already open post-finalize); e2e covers skip → add-later → product photo appears (D8) → menu offers replace.
- **backup.sh ordering + cleanup:** the DB snapshot was taken BEFORE the images tar, so an image deleted in the gap (photo removal, draft abandon) yielded a restored DB referencing a missing file. Now one in-container step tars images FIRST, then snapshots, then appends (deletion in the gap is captured by the later snapshot; an add is at worst an orphan file); temp files are trap-cleaned on failure and the host tar is written via temp-name + `mv` so a named backup is always complete.
- **e2e gaps closed:** suite 25 → 29 per engine (57 green + 1 intentional webkit skip): membership FORBIDDEN (403) now exercised for settle and adjust (was zod-400s only); the creator-side "no dot" assertion now awaits the `hasNew` refetch and asserts on its payload (was racy-vacuous); recount/write-off against a DRAFT lot → 412 (the finalize-overwrites-remainingCount hazard); a backup.sh smoke test (chromium project only) runs the script against the live stack and asserts tar contents, images-before-snapshot ordering, and temp-file cleanup — the first automated coverage the backup path has.

**2026-07-02 — done.** Shipped settlements, inventory adjustments, ledger "new" markers, and backups per blueprint 01/02/04 §5. `slice4_adjustments` migration: `Adjustment` (RECOUNT/WRITE_OFF, `countBefore` server-read, no amount column — amountless by construction per invariant 8) + `User.ledgerSeenAt`. Server: `ledger.settle` (SETTLEMENT entry, payer = creditor per D5, member of payer *or* payee household), `ledger.adjust` (ADJUSTMENT with required note; own household must be creditor or debtor), `ledger.markSeen`/`ledger.hasNew`, `adjustment.recount`/`adjustment.writeOff` (owner-household-only per the authz matrix, FINALIZED-only, one `dbTransaction` each with the B3 read-`countBefore`-then-guarded-`updateMany` retry). UI: settle sheet off the ledger hero (amount prefilled to zero the pair, direction prefilled toward zero, Cash/Venmo/Other chips + note), manual-adjustment sheet under the ledger header `⋯`, lot `⋯` menu (own pantries only) → Recount / Write off / View restock sheets with copy steering spoilage to write-off and drift to recount, adjustment history on the restock detail, "new" dot on the Ledger tab + accent-dot row highlight for entries created since the viewer's last look by the *other* household (viewing marks seen; the highlight lives until the next visit — this is the v1 counterparty notification, push lands in slice 7). Backups: `scripts/backup.sh` (online SQLite snapshot via better-sqlite3's backup API inside the running container + images in one tar, per 04 §5) and `scripts/restore.sh`, documented in README; restore path exercised for real (backup → `down -v` → restore → identical row/image counts, healthy app, login OK).

Verified: 50 Playwright tests green (25 × chromium-light / webkit-dark) against a fresh `docker compose down -v && build && SEED_DEMO=1 up --wait` stack, then green again unchanged against the same live stack (rerun-safe deltas). Slice-4 coverage: settle prefills + settle-to-zero asserted from both households with mirrored signs, recount down/up changing live inventory with both rows in the restock-detail history, non-owner recount 403 and no `⋯` menu on foreign pantries, write-off with reason chips decrementing (reason required: missing/blank → 400, overcount → 409), both adjustment types provably ledger-free (net delta 0), manual adjustment in both directions moving the net exactly (server-required note), and the full ledgerSeenAt loop (counterparty dot appears → row highlighted + `data-new` → dot clears on viewing → highlight gone next visit; creator household never flagged). Dark mode spot-checked by screenshot (settle/adjust/lot-menu/recount/write-off sheets, ledger markers, restock header).

Decisions/deviations, with reasons:

- **Settle "method" chips post as part of the note** (`"Venmo — july"`): D5 specs a single free-text `note`; a separate method column would be schema for a display concern. The ledger row renders `Settlement · <note>` per the 02 sketch.
- **Write-off reason = chip + optional free text** joined into `Adjustment.note`; the server just requires a non-empty reason string. Same rationale.
- **ADJUSTMENT entries file under the Payments chip** — 02 gives them no chip; Payments (settlements + repairs) beats hiding them in All-only.
- **`markSeen` timestamps the ledger view, not per-pair**: with >2 households, viewing one pair marks everything seen. Fine at 2 households; revisit with the pair picker if it ever matters. *(Superseded by the code-review fixes above: markSeen is now per-pair and render-timestamped.)*
- **Recount sheet uses a number input flanked by steppers** rather than 02's pure stepper — a 24→7 recount shouldn't take 17 taps.
- **`hasNew` counts every entry type**, not just settlement/adjustment: the dot means "your ledger changed and you haven't looked", which takes (the commonest entry) also do. The two push events in slice 7 stay per 04 §4's minimal list. *(Amended by the code-review fixes above: only the creating USER is excluded now, not their whole household.)*
- Carry-along polish from the slice-3 demo: lot-expand chevron grew to a full-height 56×56 target on the product row; restock-detail header no longer wraps the back arrow under the code at 390px (shrink-0 arrow, min-w-0 text column, subtitle breaks at separators, never mid-parenthetical); all five new sheets use the `bg-scrim` token.
- Migration hygiene: `prisma migrate dev` stamped the new migration *before* the hand-named `20260702230000_slice3_take_client_key`, which would apply out of order on fresh databases — renamed to `20260702234000_slice4_adjustments` (they're independent, but order should read true).

### Slice 5 — VLM extraction

**2026-07-02 — real-receipt live scoring (orchestrator gate).** Aaron supplied a real Dave's Markets iPhone receipt photo with hand-transcribed ground truth (12 lines, TAX $1.72, BALANCE $70.12; lines + tax = balance to the penny). Committed as `e2e/fixtures/receipt-daves.jpeg` (EXIF/GPS stripped via `magick -auto-orient -strip`, downscaled to 2048px, mirroring the app's upload path); the raw original stays gitignored. Live extraction through the real `extractReceipt` path (`claude-opus-4-8`, 4,995 in / 628 out tokens ≈ $0.04, 10.4s): **10/12 lines exact** — the weighted line (`0.58 lb @ 3.99/lb` → 1u × 231¢) and both duplicate CLAM PACK lines came back correctly, TAX/BALANCE were correctly excluded, `receiptTotalCents=7012` read from BALANCE, and the model read GERBER THIGHS as 479¢, catching a 4.99 error in the human's first transcription. Miss: both visually identical 12-pack lines extracted as 1059¢ instead of 1069¢ (single-digit misread, duplicated) — arithmetic proves the receipt right, and the D7 reconcile banner surfaces it as "$1.92 short" vs the expected $1.72 tax. Lesson recorded: extraction is advisory by design; the reconcile-vs-receipt-total check is the load-bearing safety net, and taxed receipts will always end in the explicit variance acknowledgment (per D7 — per-line tax allocation stays a post-v1 door). Multipacks extract as eaches (12u × pack price), which matches SPEC's break-into-eaches semantics.

**2026-07-02 — code-review fixes (behavior changes).** A review pass on the uncommitted slice confirmed findings across money/spec/authz/tests; all fixed and re-proven end-to-end:

- **Proposals are now server state (spec/money):** unconfirmed proposals lived in `useState` inside `LinesStep` and died on refresh/tab-kill/step-back, violating blueprint 02's survival contract — and Re-extract happily re-proposed already-confirmed lines, so one tap could double-count a line into the purchaser credit. Now: `restock.get` returns the stored `extractionJson` lines plus a new `Restock.extractionResolved` column (JSON array of confirmed/dismissed line indices, folded into the still-uncommitted `slice5_extraction` migration); Confirm/Edit-save/Dismiss persist the resolution via the new `restock.resolveProposal` mutation; the pending list is DERIVED (lines − resolved − lines matching existing lots). Re-extraction resets the resolved set and the lot dedupe (name+units+total first, then units+total for confirms that matched a differently-named product) suppresses re-proposal of confirmed lines. Rehydration is free — no extra API call after a reload.
- **Discounted receipts no longer over-credit the purchaser (money):** the prompt now instructs netting item-attached discounts/instant-savings into the item's `lineTotalCents` and never emitting a discount as its own line; client-side, non-positive proposed totals are DROPPED (previously clamped to $0.00, which silently preserved the full-price overstatement).
- **Extract memory cap (authz/DoS):** `restock.extract` buffered every receipt image into memory unbounded (120 uploads × 8MB ≈ 2GB with base64 expansion → OOM the single container). Now capped at 8 pages / 24MB total, checked before buffering.
- **Model-output sanitization completed:** `description` is sliced to saveLine's 200-char product-name cap (a >200-char model description made 1-tap Confirm surface a raw zod error); numeric clamps unchanged.
- **Fixture-mode malformed JSON degrades instead of 500ing:** `JSON.parse` of a fixture ran outside try/catch, breaking the module's "never throws" contract; shared `parseStoredExtraction` helper now guards both fixtures and the stored `extractionJson`.
- **Failure notice is dismissible + 44px targets (blueprint 04 §3 / 03 §4):** the extraction-failure banner gained a Dismiss button and the Try-again control grew from an underlined text link to a `min-h-11` button.
- **PII guard:** an untracked real iPhone photo (EXIF GPS verified) sat in `e2e/fixtures/`; `.gitignore` now excludes it explicitly so a `git add -A` can never commit it.
- **Rate-limit budget is mode-aware:** 20 extracts/user/15min in live mode (API spend bound) but 200 in fixture/off (zero spend) — the e2e suite previously poisoned its own budget and went red on the 5th consecutive run within a window.
- **Tests:** slice-5 e2e grew 6 → 9 per engine and hardened: proposal persistence across step-back AND reload; re-extract dedupe; a hostile-output edge fixture (`receipt-edge.jpg`: 240-char description, unitCount 0/50000, −$3.00 discount line, $0.00 promo — clamps + drops asserted, long-name Confirm succeeds); zero-line extraction notice + dismiss; the retry assertion now proves a second `restock.extract` call fires (was vacuous against the pre-click DOM); the product-match test creates its own product (was coupled to the happy-path test's side effects); the off-mode affordance is covered on every run via a response-interception test of the client `canExtract` (the suite's one declared mock) and for real by the new `npm run e2e:off` script (boots an off-mode stack, runs the real test, downs it). New `npm run test:unit` (tsx --test, no network) covers the live error-mapping chain (refusal/max_tokens/null parse; RateLimit/Auth/Connection/API/unknown errors), the stored-JSON parsers, and the malformed-fixture degrade path — the liveExtract branches e2e can't reach.

**2026-07-02 — done.** Shipped Claude-powered prefill of the receiving review screen per blueprint 04 §3 + 02's step-3 contract. `slice5_extraction` migration (hand-timestamped `20260703000000` to keep ordering after `…234000_slice4`): `Restock.extractedAt/extractionModel/extractionJson` (audit metadata; still mutable post-finalize per 01's immutability note) + `RestockImage.originalSha256`. `src/server/extraction.ts` is the mode switch (`EXTRACTION_MODE=off|fixture|live`, default off): live = `@anthropic-ai/sdk` (0.110.0) `client.messages.parse` with `zodOutputFormat(ReceiptSchema)`, `thinking: adaptive`, no sampling params, images-before-text base64 blocks over ALL receipt pages in position order, guards for `stop_reason` refusal/max_tokens and null `parsed_output`, typed-error catch chain most-specific-first, per-call token/latency log; fixture = deterministic lookup of `src/server/extraction-fixtures/<sha256>.json` keyed by the FIRST image's `originalSha256` (the client hashes the ORIGINAL selected file via `crypto.subtle` before the canvas downscale, sends it as an `originalSha256` form field with the upload, and it's persisted at attach); unknown sha = the simulated failure. Every failure path returns `{ status: 'unavailable', reason }` — advisory per SPEC §5, never blocks the wizard. `restock.extract` mutation: DRAFT-only (412 after finalize, checked before consuming budget), any-member like other draft edits, rate-limited 20/user/15min (429), returns proposed lines WITHOUT writing them — the client materializes only user-confirmed lines through the normal `saveLine`. UI on step 3: "✨ Extract from receipt" (visible only when mode ≠ off — `restock.get.extractionEnabled` — and the draft has photos), skeleton while extracting, warn-banner + Try-again on failure with the manual path untouched, and proposal rows (● accent dot per 02) each showing description/units/line-total/unit-cost plus a product-match suggestion via the existing `product.search` (longest plain word of the description); Confirm = 1 tap → `saveLine` prefilled (matched product, else create-new with the proposed description, all units received); Edit opens the normal line sheet prefilled; Dismiss drops the proposal. Replaced the 1×1 receipt fixture with a realistic rendered Costco-style receipt (12 lines, subtotal/tax/total $133.55; `scripts/generate-receipt-fixture.ts` regenerates the JPEG + its sha-keyed extraction JSON together). Env plumbed through `.env.example`/compose (`EXTRACTION_MODE=${EXTRACTION_MODE:-off}` etc.; key passed from the host env at runtime, never baked into the image) and documented in README.

Verified: 67 Playwright tests green + 3 intentional skips (70 total = 35 × chromium-light / webkit-dark) against a fresh `docker compose down -v && build && SEED_DEMO=1 EXTRACTION_MODE=fixture up --wait` stack, then green again unchanged against the same live stack. Slice-5 coverage: extract → 12 proposals → 1-tap confirms landing as draft lines at D1 unit costs ($8.99/3 → $3.00/u) → edit-prefilled sheet with a hold-back (recv 23/24) → dismiss → finalize; suggestion match asserted in a second draft against the product the first created; unknown-sha receipt → friendly retriable notice + manual entry finalizing normally; unauthenticated 401 / finalized 412 / missing 404; per-user rate limit tripping 429 (dedicated user so budgets never starve the happy paths across engines/re-runs). The off-mode test self-skips on fixture stacks and passed 2/2 for real against a `SEED_DEMO=1 docker compose up` (default off) stack — the affordance is absent with photos present. Dark mode spot-checked by screenshot (proposal rows, extract button, prefilled edit sheet).

**Live smoke (real API, actual ExtractionService code path — `scripts/extract-live-smoke.ts`):** model `claude-opus-4-8`, 1 page, **12/12 lines matched the receipt's ground truth exactly** (descriptions, unitCounts incl. 8/12/24/30/35-count multipacks, integer cents) and `receiptTotalCents` matched (13355); usage 3,464 input / 622 output tokens (≈ $0.03 at $5/$25 per MTok), latency 9.7s. One quirk: `purchasedAt` came back `"2026-06-28T14:07:00"` (datetime, not bare date) — schema-legal (plain string) and currently unused by the UI, since step 1 already owns the header fields.

Decisions/deviations, with reasons:

- **Extraction fixtures live in `src/server/extraction-fixtures/`, not 04's `e2e/fixtures/extractions/`** — `.dockerignore` excludes `e2e/`, and the server must read the JSON at runtime inside the container. The receipt JPEG stays under `e2e/fixtures/` (it's test-runner input).
- **The extract button sits on step 3 (line review), not 02's step-2 sketch, and there is no auto-run** — proposals are client-state reviewed on the very screen they land on, so one screen owns the whole advisory flow; auto-run would silently spend API budget (and the per-user rate limit) on every step-3 entry. 02's flagged-proposed-lines contract (● dot, confirm-by-touch) is what shipped.
- **The upload route validates + echoes `originalSha256`; persistence happens in `restock.addImage`** — the route stores files, not rows; the RestockImage row (where 04 §3 wants the column) is created at attach. The form-field contract is otherwise as specified.
- **Extraction is DRAFT-only in v1** — SPEC's "re-process later as extraction improves" stays a door (the columns remain mutable post-finalize); the UI only offers extraction inside the wizard anyway.
- **Extraction's header fields (retailer/date/total) are returned but not applied** — step 1 already captured them; 02's prefill contract covers lines only.
- **Per-line `confidence` is requested, stored in `extractionJson`, and not yet surfaced** — every proposal needs explicit confirm/edit/dismiss regardless, so a confidence badge adds noise before it adds signal.
- Proposal `unitCount`/`lineTotalCents` are clamped client-side into `saveLine`'s accepted ranges before confirm — model output is untrusted input.

### Slice 6 — Lending

**2026-07-02 — code-review fixes (behavior changes).** A review pass on the uncommitted slice confirmed findings across money/authz/spec/integrity/tests; all fixed and re-proven end-to-end:

- **Item history no longer claims reversed fees (money/spec):** `/items/[id]` computed the displayed fee purely from the borrower-household rule, so an undone checkout (LOAN_FEE + REVERSAL netting $0) permanently rendered "fee $5.00" — contradicting this slice's own "history never claims money moved" rule. The loader now joins the ledger by hand (LOAN_FEE entries for the page's loans → REVERSALs referencing them; LedgerEntry stays relation-free) and the row renders a struck-through "~~fee $5.00~~ reversed" annotation instead.
- **Checkout fee TOCTOU closed (authz/money):** `loan.checkout` charged `item.feeCents` as read at mutation time while the sheet displayed the page-load fee read-only — an owner edit in between charged the borrower an amount they never saw. The mutation now takes `expectedFeeCents` (the fee the sheet displayed, sent by the client); a mismatch rejects with 412 instead of posting. Optional at the API level, always sent by the UI.
- **`item.create` gained the clientKey replay pattern (integrity):** the add-item sheet's only double-submit protection was `disabled={isPending}`, which lands a render late; a photo-less create has no other server-side dedupe, so a fast double-tap minted twin items. `Item.clientKey` (unique, folded into the still-uncommitted `slice6_lending` migration) + the same replay-returns-original transaction shape as Take/Adjustment/Loan; the sheet generates one key per open.
- **Receive-wizard "✓ Added — now in the lines below" flash was false for its 900ms (spec, slice-5 carry-along):** the row delayed `resolveProposal` (whose refetch surfaces the lot in the list and the reconcile math) behind the flash timer. The resolve + refetch now fire immediately on save; the flash row lifted from `ProposalRow` into `LinesStep` state so it survives the row's unmount — only the purely visual collapse is on the timer.
- **Tests:** slice-6 e2e grew 5 → 9 per engine: the full item-photo pipeline (forged/wrong-kind/missing-path 400s, attach-uniqueness 409 with the referenced file surviving, replace unlinking the old file, re-attach 409, remove unlinking — asserted via `/api/images/*` statuses); fee-snapshot immutability (owner edits the fee mid-loan: net/ledger/history keep the $4.00 snapshot; a stale `expectedFeeCents` checkout 412s uncharged; a fresh one charges the new fee); undo grace-window expiry (412 for borrower AND owner, fee stands, normal return still works); third-household FORBIDDEN on `loan.return`/`loan.undoCheckout` (both 403, then the real borrower returns fine). The last two use a documented `docker compose exec` seam into the app container (backdating `Loan.outAt`; an ephemeral third household created/removed around the test — invites can only join existing households and slice-1 asserts exactly two). The undo test also asserts the new "reversed" history annotation; the authz test covers item.create replay. Slice-5 spec grew the missing regression test for its carry-along polish: product-match latency injected via route delay (real response, delayed — not a mock) proves "matching…" holds Confirm disabled, and the saved flash is asserted to coexist with the already-visible line row below.

**2026-07-02 — done.** Shipped lending per blueprint 01 (Item/Loan, invariant 10, authz matrix) and 02's lending section. `slice6_lending` migration: `Item` (household owner, name, photoPath, notes, `feeCents` default 0) + `Loan` (itemId, borrowerId user, feeCents snapshot, outAt, dueAt?, returnedAt?, conditionReturned?, `clientKey` unique) — plus a **raw-SQL partial unique index** `Loan(itemId) WHERE returnedAt IS NULL` (blueprint critique B9: SQLite supports partial indexes, Prisma's schema language can't express them; hand-added in the migration file and proven to reject a second active loan while allowing one after return). Server (`src/server/routers/item.ts`): `item.create`/`item.update` (owner-household-only; photos via the existing upload pipeline, kind `items`, with the fresh-upload/attach-uniqueness contract and post-commit unlink of replaced files; item photos joined the boot-time orphan sweep's referenced set), `loan.checkout` (borrower = acting user per repair A6 — no picker; one `dbTransaction`: clientKey replay returns the original loan, active-loan guard, fee SNAPSHOT onto the loan, LOAN_FEE posted iff fee > 0 AND cross-household with creditor = item owner per invariant 10; P2002 from the partial index maps to the same 409), `loan.return` (borrower or owner household; guarded `updateMany` on `returnedAt: null` so double-returns fail closed; optional condition note), `loan.undoCheckout` (mistaken-checkout escape: return-immediately + swapped-party REVERSAL referencing the LOAN_FEE entry, gated to borrower/owner household within a 15-min grace window, mirroring take.undo). UI: Items tab enabled (all four tabs now live — the greyed-tab machinery in `tab-bar.tsx` was deleted as dead code); `/items` groups by household yours-first with photo thumbs, `$X/loan` fee badge only when nonzero, `Available`/`Out → X` status line and overdue badge; `/items/[id]` detail (photo, notes, fee, status, loan history with condition notes and charged fees, owner-only Edit sheet); check-out sheet ("You're the borrower" copy, optional native due-date input, read-only fee with "posts to the ledger now, not at return" warn banner when it will post, "No fee — your household's own item" otherwise) with a 10s undo toast; return sheet with optional condition note. Ledger enrichment grew LOAN_FEE (`Loan fee · <item>`) and its REVERSAL (`Undo loan fee · <item>`) labels plus a "View item" link on expanded rows.

Verified: full suite 83 green + 3 intentional skips (both engines, chromium-light/webkit-dark) against a fresh `docker compose down -v && build && SEED_DEMO=1 EXTRACTION_MODE=fixture up --wait` stack, then green again unchanged against the same live stack. Slice-6 coverage (5 tests × 2 engines): UI add-item with $5 fee visible to the other household with the badge → cross-household checkout moving BOTH heroes by exactly ±500¢ with `Loan fee · <item>` rows at −$5.00/+$5.00 → return with condition note landing in history (fee stays posted) → API double-return 409; zero-fee cross-household and fee-bearing own-household checkouts provably ledger-free (net delta 0, no row); clientKey replay returning the same loanId with one −300¢ movement, second concurrent checkout 409 (by borrower AND owner), undoCheckout restoring net with the original row intact (append-only) + REVERSAL row + second undo 409 + unknown item 404 + impossible due date 400; item.create-for-other-household 403, foreign item.update 403 with no Edit affordance, owner fee edit updating the badge; overdue badge on list row and detail for an API-created loan due 3 days ago. Dark mode spot-checked by screenshot (items list, detail, checkout/add sheets).

Decisions/deviations, with reasons:

- **`Loan.conditionOut` (01's schema) dropped; single `conditionReturned`** — SPEC §4 and 02's sheets only ever surface a return-time note; a checkout-condition field had no UI surface anywhere in the blueprint. Add the column when a flow wants it.
- **No fee refund in v1 (01 is silent):** a mistaken checkout is undone by returning immediately; `loan.undoCheckout` posts the swapped-party REVERSAL against the LOAN_FEE entry within a 15-minute grace window (borrower or owner household), exactly the take.undo shape. Outside the window the fee stands — settle up or manual-adjust if it ever actually matters.
- **`item.create` takes an explicit `householdId` that must equal the caller's** — items can only ever be filed under your own household, but the explicit echo fails loudly (403, e2e-covered) instead of silently refiling, and keeps the input shape honest if items ever get transferable.
- **No `item.list`/`item.get` tRPC queries** — `/items` and `/items/[id]` are server components reading Prisma directly (the slice-1 convention every other tab follows); mutations go through tRPC and `router.refresh()`. Nothing client-side needed a list query.
- **LOAN_FEE files under the All chip only** (filterGroup `other`) — 02 gives it no chip and none of Takes/Credits/Payments fits; the row label + "View item" link carry the context.
- **Loan history shows the CHARGED fee** (0 for own-household loans regardless of the snapshot) so history never claims money moved when invariant 10 says it didn't. *(Completed by the code-review fixes above: fees reversed by undoCheckout are now annotated "reversed" too.)*
- **`Loan.feeCents` snapshots `item.feeCents` even for own-household checkouts** (per 01's "snapshot at checkout"); the posting rule, not the snapshot, decides whether money moved.
- Carry-along polish from the slice-5 demo: (a) proposal rows now show a "matching…" placeholder while the product-match suggestion resolves (Confirm stays disabled) instead of flashing "new product" — no more confirming into a duplicate product during the async window; (b) the desktop-light-chromium "darker patch" on the disabled wizard Next button was `disabled:opacity-50` promoting the button to a compositor layer that Chromium rasterizes in tiles with per-tile color rounding (a 1-RGB-unit vertical seam at a tile boundary, verified by pixel-scanning the slice-5 screenshots); the disabled state now uses translucent colors (`disabled:bg-accent/50 disabled:text-accent-contrast/70`) — no layer, no seam, pixel-scan now uniform; (c) a confirmed proposal collapses to an inline "✓ Added — now in the lines below" flash for ~900ms, so the row no longer teleports to the bottom list with no nearby feedback. *(Reworked by the code-review fixes above: the resolve + refetch now fire immediately — the flash's claim is true while it shows — and only the visual flash rides the timer; a tab-kill in the window is still covered by the lot dedupe.)*

### Slice 7 — PWA polish

**2026-07-02 — code-review fixes (behavior changes).** A review pass on the uncommitted slice confirmed twelve findings; all fixed and re-proven end-to-end:

- **Push-endpoint SSRF closed (authz, major):** `push.subscribe` stored any `z.url()` and `sendPushToUsers` POSTed to it — a blind SSRF primitive for any authenticated member (cloud metadata, LAN probing), made worse by the raw-`fetch` transport that deliberately allows plain http. New `isAllowedPushEndpoint` guard (`src/server/push-endpoint.ts`, unit-tested): public HTTPS on port 443 only, no IP literals, no credentials, no intranet-shaped hostnames (`localhost`/`.local`/`.internal`/`.home.arpa`/dotless) — the e2e sink's loopback is allowed ONLY under `SEED_DEMO=1` at its exact path. Enforced at subscribe (400, e2e-covered for six SSRF shapes) and re-checked at send time (stale rows are skipped, never fetched).
- **Committed VAPID private key can no longer serve a real deployment (authz, major):** the compose file defaulted `VAPID_PRIVATE_KEY` to the committed dev pair, so a plain `docker compose up` ran push with a world-readable key behind only a boot-log warning. Compose now defaults both keys EMPTY (push disabled); the entrypoint injects the dev pair only when `SEED_DEMO=1` (e2e stays zero-setup) and **refuses to start** (exit 1) a non-demo stack configured with it.
- **Notifications card now reports the SERVER's subscription, not the browser's (spec):** after a user switch on a shared device the card claimed "notifications are on" for whoever was signed in, while pushes kept going to the previous subscriber. The card now joins `pushManager.getSubscription()` with `push.status` (which existed for exactly this and was never called); a browser subscription owned by someone else gets explanatory copy + the turn-on button (re-subscribing reassigns the endpoint, no second permission prompt).
- **A scanned UPC now sticks to an EXISTING picked product (spec, major):** `saveLine`'s code rode along only with `newProductName`, so pre-slice-7 products could never gain a UPC — the same can missed on every future restock, and the only "fix" was a duplicate product v1 can't merge. `saveLine.upc` (renamed from `newProductUpc`) now also fills in a missing `Product.upc` when an existing product is picked (never overwrites a set one); picking a product that already has a different UPC drops the pending code.
- **Pending-UPC is visible to the end, never silently attached (integrity):** the chip used to vanish once a product was selected while the stale code was still sent — an abandoned scan could stamp the wrong UPC onto an unrelated new product, making future scans auto-select the wrong product forever. The chip now stays rendered through Save in every picker state with contextual copy ("will be saved onto {name}" / "with the new product") and the ✕ to drop it.
- **UPC normalization is now server-side too (integrity):** `product.search` matched the raw query and `saveLine` stored the raw code, so a scanned 12-digit UPC-A and the 13-digit EAN printed on the box split one SKU into duplicate products. Both now canonicalize through the same `normalizeScannedCode` the scanner uses; e2e proves a typed 13-digit query finds the scan-created 12-digit product.
- **Find-by-scan added to the take flow (spec):** SPEC §5's "find product (search/scan)" now exists — the pantry search gained the same camera-gated Scan button (blueprint 02's `[scan]`); a match jumps straight into the product's take sheet (FIFO suggestion and all), a miss shows a notice. This supersedes the "deliberately not added" deviation note below.
- **iPadOS 13+ detection (spec):** both /more cards sniffed `/iPad|iPhone|iPod/`, but modern iPad Safari reports a desktop Macintosh UA — iPads got un-followable Chrome-menu install steps and "browser doesn't support web push" instead of the install-first guidance. Shared `isIOSDevice()` also treats Macintosh-UA + `maxTouchPoints > 1` as iOS (real Macs report 0); e2e covers the spoofed-iPad context.
- **Scan sheet no longer restarts the camera on parent re-renders (spec):** the getUserMedia effect depended on the parent's per-render `onDetected` callback, so any LineSheet update while aiming (e.g. a query refetch on refocus) killed the stream, re-initialized the WASM detector, and turned the torch off. The callback now flows through a ref and the effect runs once per mount.
- **Camera-detection path has real coverage (tests, major):** `onScanDetected` ran in no automated test. The sheet now exposes a documented seam (`window.__coopScanEmit`) that drives its real normalize→flash→deliver pipeline — the exact hook the review suggested; new e2e (both engines, rerun-safe per-run codes, emitting the 13-digit EAN form) covers: no-match keeps the code visible → picking an EXISTING product attaches it → rescan auto-selects; create-new carry-along → rescan matches; and the pantry scan-to-take flow incl. the no-match notice. Only the camera-frames→rawValue hop stays hardware-only (owner task).
- **Push sink pins the request envelope (tests):** the sink recorded only body bytes + TTL, so dropping the VAPID `Authorization` header or sending plaintext JSON would stay green while real push services 400/401 every send. It now records `Authorization`/`Content-Encoding` and e2e asserts `vapid t=…k=…` + `aes128gcm`.
- **No-camera degradation branch actually executes (tests):** the old scan-button test's `!hasCameraApi` branch was dead code on localhost (always a secure context). New forced tests: a context with `navigator.mediaDevices` deleted proves BOTH scan buttons (line sheet, pantry search) hide with manual search intact, and a context whose `getUserMedia` always rejects `NotAllowedError` proves the denied-permission copy points at the manual path.
- **Field bugs found while re-proving (tests):** (1) Requests from SW-controlled pages bypass `page.route()` in WebKit, so the slice-7 service worker silently disarmed the slice-5 response-interception tests (green-or-red by registration timing). Fixed at the source: `PwaSetup` skips SW registration under automation (`navigator.webdriver` — automated browsers can't receive push anyway; real devices unaffected) and the interception tests neuter `ServiceWorkerContainer.prototype.register` as a belt (`disableServiceWorker` helper). Playwright's `serviceWorkers: 'block'` option is NOT usable instead — under it WebKit's second-and-later contexts hang on their first navigation. (2) WebKit wedges by browser AGE: after ~55–65 tests in one browser process, a fresh page's first `goto()` hangs without ever completing while the server sits idle (traced across five full runs; the victim was always whichever test ran at that point — push tests, take-flow, manual-UPC; chromium never). Fixes: slice 7 runs as its own `webkit-slice7` project (a project gets its own worker = a FRESH browser, keeping every webkit browser under the threshold), webkit projects carry `retries: 1` as the net (a retry also starts a new worker; a real regression still fails twice and reports red), the push tests' second/third users became pure `APIRequestContext` sessions (`apiLogin`) instead of extra browser contexts, and the seam-driven scan tests stub `getUserMedia` (they test the detection handler, not the capture pipeline, which keeps its own dedicated test — and webkit's mock capture churn was the other big destabilizer, 20s → 3s per test). (3) Restock-code assertions relaxed to `\d{2,}` — the NNth restock of a day legitimately passes 99 on a long-lived shared test DB. Final proof: 131 passed + 3 intentional skips, zero flaky, twice in a row (fresh `down -v` stack, then again unchanged against the same live stack).

**2026-07-02 — done.** Shipped the final slice per blueprint 04 §2/§4 and 02's PWA section: installability, web push, camera barcode scanning, and the whole-app design pass.

**Installability.** `src/app/manifest.ts` (name "Private Coop", short_name "Coop", standalone, start_url `/`, stone-900 theme/background per 02); icons drawn once as `assets/icon.svg` (emerald jar on stone, art inside the maskable safe zone) and rasterized to the committed PNGs (192/512/512-maskable/apple-touch-180) by `scripts/generate-icons.ts` — a headless-chromium screenshot script, same no-native-deps reasoning as the sharp rejection. Layout gained `viewport-fit=cover`, per-scheme `<meta theme-color>` (the manifest spec only has one color, so the splash is stone-900 in both schemes — noted deviation from "both schemes if supported": the manifest doesn't support it), and the iOS standalone metas (Next 16 renders `appleWebApp.capable` as the modern `mobile-web-app-capable`). `/more` grew a dismissible install card: captured `beforeinstallprompt` → native Install button (the event is stashed app-wide by `src/app/pwa-setup.tsx` since Chrome fires it before /more mounts); iOS → Share → Add-to-Home-Screen pictogram steps; neither → generic browser-menu guidance. Service worker `public/sw.js` is push+notificationclick ONLY — no fetch handler, no caches (offline out of scope; stale money data must be impossible) — registered with `updateViaCache:'none'` and served with no-store + strict CSP headers via `next.config.ts` (which also gained the guide's baseline security headers app-wide).

**Web push.** `slice7_push` migration: `PushSubscription` (per-user, endpoint unique, cascade delete; verified equal to the schema via `prisma migrate diff`). `push` tRPC router: `publicKey` (VAPID public key read from env at RUNTIME — deliberately not `NEXT_PUBLIC_`, per 04 §4), `subscribe` (upsert by endpoint — a browser belongs to its last subscriber), `unsubscribe`/`status` (scoped to the caller's own rows). Notifications card on /more: explicit tap-to-subscribe (permission prompt ONLY on tap, never on load — e2e asserts `Notification.permission` stays unprompted), unsupported-browser copy (iOS: install first), unconfigured-server copy. Exactly TWO events (blueprint 09): settlement recorded and manual adjustment posted — `notifyLedgerEvent` fires AFTER the money transaction commits, un-awaited, to all members of BOTH involved households except the creating user (matching the slice-4 "new"-marker semantics), failures logged never thrown, clientKey replays never re-notify, and 404/410 from the push service prunes the row. VAPID keys via `VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT` (README documents `npx web-push generate-vapid-keys`; empty = push disabled).

**Camera barcode scanning.** `barcode-detector` 3.2.0 ponyfill (W3C API over zxing-wasm; `npm view`-verified) — the WASM loads via dynamic `import()` only when the scan sheet opens. The receive wizard's line-sheet product picker grew a Scan button (rendered IFF `navigator.mediaDevices.getUserMedia` exists — hidden on plain-http LAN, the graceful degradation) opening a camera sheet: environment camera, torch toggle when the track supports it, UPC-A/EAN-13 detect loop, visual flash on hit. Scanned codes are normalized (13-digit EAN with leading 0 → 12-digit UPC-A, `src/lib/barcode.ts`, unit-tested) and fed through `product.search`, which now also matches `Product.upc` for digit queries (so manually TYPED UPCs work everywhere the scan button does, per 04 §2) — match prefills the product; no match keeps the UPC as a badge and saves it onto the inline-created product (`saveLine.newProductUpc`). Camera failure (denied/absent) renders an explanation pointing at the manual path.

**Design pass** (every screen, both schemes, 390px + 1280px, screenshot-walked): (a) desktop stays the centered column per 02, widened where free — pantries and items household groups go 2-col at `lg` (page `max-w-4xl`), the ledger hero becomes number-left/Settle-right at `sm+`; (b) light-mode scrim deepened 0.45 → 0.55 (slice-6 demo obs 3 — it read washy on big white desktop surfaces); (c) login/invite got the standalone-page treatment: the jar mark in accent (new `src/app/brand-mark.tsx`, currentColor so it follows the scheme), form in a raised card, inputs/buttons brought up to the 03 recipes (min-h-11, focus rings, translucent disabled state); the Pantries header also carries the mark now; (d) empty states: ledger empty is a proper warm empty-state card ("All square so far."), own-pantry empty explains what receiving does before the CTA; (e) standalone safe-areas: `viewport-fit=cover` + body `padding: env(safe-area-inset-top/left/right)` in globals, tab bar already had the bottom inset, and the FAB/take-toast fixed offsets now add `env(safe-area-inset-bottom)` so they clear the iOS home indicator.

Verified: **full suite 135 passed + 3 intentional skips (both engines, chromium-light / webkit-dark)** against a fresh `docker compose down -v && docker compose build && SEED_DEMO=1 EXTRACTION_MODE=fixture docker compose up -d --wait && npx playwright test`. Slice-7 e2e (26 across both engines): manifest fields + every promised icon resolving as PNG; sw.js content-type/no-store/push-only (asserts NO fetch handler and no `caches.`); per-scheme theme-color + viewport-fit + apple metas; install card render → dismiss → stays dismissed, iOS-UA variant showing the Share steps; notifications card never auto-prompting; push authz negatives (subscribe/unsubscribe/publicKey all 401 unauthenticated, garbage payload 400); subscribe/unsubscribe CRUD incl. endpoint reassignment to its last subscriber and foreign-unsubscribe no-op; a REAL push round-trip — settlement by Aaron delivers exactly one encrypted payload each to Marie (housemate) and Dana (counterparty) and none to Aaron, Dana's adjustment notifies back, replays don't re-send, and a 410 endpoint is pruned; scan-button-iff-camera-API contract with both headless outcomes (chromium: no camera → degradation copy; webkit: mock camera → the real zxing detect loop runs without erroring); manual-UPC path (typed UPC finds the product, bad UPC 400, new product keeps its UPC). Unit tests grew the barcode normalization matrix (18 total). Dark mode spot-checked by screenshot on all new surfaces.

Decisions/deviations, with reasons:

- **Push round-trip e2e uses an in-app push-service stand-in** (`/api/dev/push-sink/[id]`, hard-gated to `SEED_DEMO=1`, 404 otherwise): headless browsers can't hold an FCM/APNs connection, so `pushManager.subscribe` against a real push service is untestable in CI. The sink receives the REAL web-push output — VAPID-signed, aes128gcm-encrypted HTTP POSTs — so everything except the browser's own delivery is exercised; `?status=410` makes pruning testable. Browser-side subscribe + notification display is an owner task on real phones (below).
- **`sendPushToUsers` uses web-push's `generateRequestDetails` + `fetch`** instead of `webpush.sendNotification`, which hardcodes node's `https` module and refuses the sink's plain-http endpoint (verified by smoke test — it TLS-handshakes an http URL). Same library does the signing/encryption; only the transport differs. Real push services are always https.
- **docker-compose.yml defaults to a committed, publicly-known dev VAPID keypair** so the standard e2e invocation exercises push with zero setup. Real deployments set their own keys via env (README); the entrypoint prints a loud warning when the dev pair is live outside `SEED_DEMO=1`. No real/production key is committed.
- **The manifest carries one theme/background color (stone-900, per 02)** — the manifest spec has no per-scheme colors. In-browser chrome follows the scheme via the paired `<meta name="theme-color">` tags instead.
- **02's pantry-search `[scan]` button was NOT added** — this slice's scope is the line-sheet picker (where scanning answers "which product is this?" during receiving). Scan-to-filter of an inventory list adds WASM+camera plumbing to a screen where typing three letters already filters; revisit if basement-scanning turns out to be a real habit. *(Superseded by the code-review fixes above: SPEC §5 names scan in the take flow, so the pantry search got the Scan button — a match opens the take sheet directly.)*
- **Icon PNGs are committed and regenerated by `scripts/generate-icons.ts`** (playwright screenshot of `assets/icon.svg`) rather than 04's ImageMagick suggestion — no host tool dependency; playwright is already a devDependency.
- e2e full-suite invocation includes `EXTRACTION_MODE=fixture` (as every slice since 5); the 3 documented skips remain (slice-5 off-mode self-skip ×2, slice-4 webkit backup-smoke).

**Owner tasks (real-device verification):** on an iPhone (and one Android): install via the /more card, confirm the icon/splash, turn on notifications, record a settlement from the other household and confirm the push arrives with the app closed and deep-links to /ledger on tap; scan a real UPC-A barcode in the line sheet (torch toggle on the Android). Headless CI cannot cover these last-mile paths.

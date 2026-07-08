# Potluck — Build Plan

Newest-first build records: one entry per round, appended when it ships. The scope
contract is [SPEC.md](./SPEC.md) §7; the decision log is
[docs/REWORK.md](./docs/REWORK.md).

**Definition of done** (unchanged since v1): the feature demonstrated working in a real
browser against the real compose stack, Playwright e2e passing on both engines, notes
updated here. A round is never "complete" on the strength of unit tests alone.

History older than Phase 2 — rework Rounds 1–4, the rework design note, the 2026-07-03
iteration rounds, and the v1 slices — is archived verbatim in
[docs/plan-archive.md](./docs/plan-archive.md).

## Outstanding work (hoisted 2026-07-07)

The canonical deferred backlog lives in [docs/REWORK.md](./docs/REWORK.md) ("Canonical
deferred list"). Near-term items hoisted from round notes below and from the archive:

- **Receive wizard notch inset** (Round Q follow-up): the headerless receive wizard
  still starts at y=0 on notch devices — its top wrapper needs the same
  `max(…, env(safe-area-inset-top))` padding /login and /invite got.
- **MFA router per-factor aliases** — unify (cosmetic; deferred from Phase 3 Round B).
- **IMAP receipt-verify of the live DreamHost send** — the send itself is proven
  delivered; the automated receipt check awaits an auth-throttle cooldown (Phase 3).
- **Real-device owner tasks:** install the PWA on an iPhone and an Android; confirm a
  push arrives with the app closed and deep-links correctly; scan a real UPC-A barcode
  (torch toggle on Android); confirm the push-toggle "Turning on…" wedge is gone (10s
  timeout in place); rotate the `ANTHROPIC_API_KEY` and generate real VAPID keys before
  any public deployment.
- **Cosmetic backlog:** a few 390px ragged wraps (pantry header now truncates; the rest
  deferred) · the pre-existing /ledger React #418 hydration warning.
- **Phase 4 COMPLETE** (2026-07-08): all four rounds shipped — focus group ·
  placement model · transfer + receive splits · reconcile draft sessions. Round
  records below; decision record REWORK.md "Phase 4" (S1–S7 + A1–A8). Deferred
  follow-ups: a transfer-history surface (transfer.listForHousehold exists, no
  screen renders it) · A7's third shortage action "fill from another placement"
  (reduce/cancel shipped; fill is a committer convenience) · Theo's low-permission
  "this looks off" flag (A5 fast-follow) · per-row "being counted" badges on
  inventory (the 412 messages are the contextual surface for now) · stale-session
  push nudge (the banner carries age; lazy 24h auto-abandon is live) ·
  reconcile.get can cosmetically show a 24h-stale DRAFT until any freeze check or
  create flips it · legacy adjustment clientKey replay across the deploy boundary
  (accepted risk, Round 1 review).
  Observation from Round 1 review (not a regression — pre-existing): pantry/shopping
  availability filters on `receivedCount > 0`, so a credit-corrected-to-zero lot hides
  from inventory even with physical stock; revisit when reconcile lands.

## Phase 4 Round 3 — reconcile draft sessions (2026-07-08)

The stock-take (REWORK S5/S6 as amended by Round-0 A1–A8). Team: Fable (schema ·
migration · freeze in stock.ts · pure commit math + unit tests · review-gap server
additions · e2e) + GPT-5.5/codex (reconcile router) + Opus 4.8 (UI, browser-verified
twice incl. a real shortage commit) + codex review.

- **Model** — ReconcileSession (one DRAFT per household; blind flag; lazy 24h
  auto-abandon) · ReconcilePantry (scope + soft claim) · ReconcileLine (placement
  scope with expectedCount/expectedReserved baselines; countedCount null = uncounted,
  0 = explicit not-found) · `Stock.lastCountedAt` (match-confirms stamp, no no-op
  Adjustment spam) · `Transfer.reconcileSessionId`/`Adjustment.reconcileSessionId`
  (derived-vs-observed provenance) · `commitSummary` JSON (exact replay answers).
  Migration `20260708210000_reconcile` (additive).
- **Freeze (A2 cutoff)** — `assertStockMutable` in stock.ts: consume-reserved
  (pickups) rides through — count+reserved move together so the free-stock baseline
  is untouched; every free-stock mutation 412s ("This shelf is being counted").
  Companion `assertPantriesNotUnderCount` closes the created-placement escape (codex
  review High): restock finalize into, and transfer into, a counted pantry are
  refused. Lazy expiry lives INSIDE the checks — a forgotten phone can never strand
  a pantry, proven by the SQL-aged e2e case.
- **Commit** — pure `reconcile-math.ts` (unit-tested 10 cases): count-where-found
  conservation per lot → derived transfers (deterministic pairing, committer can
  reject a lot's pairing back into two variances) + residual variances + shortage
  detection. One tx, ordered: flip COMMITTED (freeze off) → shortage resolutions
  (reduce/cancel order lines, requester notified category-safe) → derived Transfers
  via moveStock → variance RECOUNT Adjustments → lastCountedAt stamps → final
  assertion (every line's stock.count === counted AND reserved ≤ count, else roll
  back). commitClientKey idempotent; every variance must be client-acknowledged with
  the exact delta (D7 consent — "Counts changed" on drift).
- **Router** — create/get/open/lotCandidates/addPantry/addLine/claimPantry/count/
  removeLine/removePantry/commit/abandon. Counting + claiming need membership only
  (A5 — the Teen can be handed the basement); create/scope/commit/abandon need
  adjustInventory. `open` answers only participants + adjustInventory holders (A3 —
  everyone else learns from the 412 at the moment they touch a frozen shelf).
- **UI (Opus)** — "Count this pantry…" scope sheet (blind default ON per Inés);
  session screen with per-pantry claim + progress; blind count walk (blank keypad
  inputs, auto-advance, explicit "0 — not found", one-tap match in non-blind,
  per-line autosave); "+ Found something" (product search → lotCandidates → count
  where found); review screen (derived moves w/ per-lot reject, variance acks,
  shortage reduce/cancel per open order line) → commit summary; participant-scoped
  household banner with Open/End. The review preview imports the SAME
  reconcile-math module the server runs (no hand-copied mirror).
- **e2e** `e2e/reconcile.spec.ts` (10 both-engine tests; chromium drives Heise,
  webkit drives In-Laws so the one-DRAFT rule never collides): freeze cutoff with a
  real READY pickup riding through, one-DRAFT conflict, derived-move commit,
  unacked-variance 412 + commit replay, finalize/transfer-into-counted-pantry 412s,
  SQL-aged lazy expiry, and the full UI walk (scope → banner → blind count → review
  → ack → commit summary).
- **Gate — green:** unit 229/229 (10 new math cases) · tsc/eslint/lint:tokens clean ·
  reconcile + transfers specs both engines · full both-engine e2e on the rebuilt
  stack (final run recorded below) · codex review: High (created-placement escape)
  fixed + e2e'd; expiry-rollback finding resolved via create's expire-then-proceed +
  in-check flips (get()'s cosmetic stale display noted); replay summary persisted;
  banner audience narrowed to A3. Deferrals hoisted to Outstanding work.

## Phase 4 Round 2 — transfer + per-line receive splits (2026-07-08)

The placement model's first visible payoff (REWORK S3/S4). Team: Fable (schema ·
migration · `stock.moveStock` · e2e spec · integration) + GPT-5.5/codex (server
routers) + Opus 4.8 (UI, browser-verified) + codex review.

- **Transfer** — `Transfer`/`TransferLine` (immutable A→B audit; lines pin exact
  source/destination placements), `transfer.create` (atomic multi-line, one
  dbTransaction, clientKey replay validates actor+pantries+LINE FINGERPRINT — a
  same-key different-payload retry conflicts instead of silently returning the
  original; review finding, fixed + e2e'd), `transfer.listForHousehold` (data for a
  later history surface). Movable = count − reservedCount via `stock.moveStock`
  (guarded source decrement; destination via ensureStock). Same-household only
  (foreign pantry reads 404), `adjustInventory`, from ≠ to, dupe stockIds rejected.
- **Receive splits** — `LotAllocation` draft rows (`restock.setLineAllocations`,
  draft-only, owner-gated); finalize validates Σ == receivedCount per line (error
  names the line), materializes one placement per allocation, deletes the rows.
  No allocations = whole line to the restock's pantry (unchanged common case).
- **UI (Opus)** — inventory-view move mode: `move-items-button` toolbar entry +
  per-lot "Move to another pantry…" menu item → quantity sheet → persistent cart bar
  (destination picker, note, atomic confirm); entry points hidden for single-pantry
  households. Receive wizard Review-lines step: per-line destination chip →
  allocation editor (pantry+count rows, live sum warning, "All to X" reset).
- **e2e** `e2e/transfers.spec.ts` (Fable-authored after a stalled codex e2e run):
  gating, UI move flow + audit row, atomic overdraw rollback, clientKey replay +
  mutated-payload conflict, foreign-destination 404, reservation cap, allocation
  split through the real wizard. SQL teardown honors the new FK order (Transfer
  before Stock; canceled Order rows still pin placements).
- **Gate — green:** tsc/eslint/lint:tokens clean · unit 219/219 · transfers spec 2×
  both engines · full both-engine e2e on the rebuilt stack **394 passed / 0 failed /
  2 flaky (pre-existing, retry-green) / 6 skipped**. Codex review: 1 High (replay
  fingerprint) found → fixed; everything else clean.

## Phase 4 Round 1 — stock placements (2026-07-08)

The bandaid rip (REWORK Phase 4 S1/S2, Round-0 A-series): inventory counts moved off
`Lot` onto **`Stock`** — the units of one lot currently in one pantry. Lot keeps
receipt lineage + frozen cost; a lot can now (Round 2+) sit in N pantries. Zero UI
delta this round. Team: Fable (schema · migration · `src/server/stock.ts` choke point ·
verifier · integration) + GPT-5.5/codex (consumer sweep) + codex review + a 5-persona
focus group (Round 0, synthesis in REWORK "Round 0").

- **Schema** — `Stock {lotId, pantryId, count, reservedCount}` (unique lot+pantry,
  durable rows — history FKs point here); `OrderLine.stockId`, `Adjustment.stockId`,
  `SharePostLot.stockId` (+ unique now (postId, stockId): two shelves of one lot = two
  offers), `Take.pantryId` snapshot (relation-free). Lot loses remaining/reservedCount.
- **Migration** `20260708150000_stock_placements` — table rebuilds with deterministic
  `stk-<lotId>` backfill ids (one placement per finalized non-excluded lot at its
  restock's pantry); preflight CHECK-abort if any history row references a
  placement-less lot (unseen deployments must fail loud, never dangle). Proven by
  `scripts/verify-stock-migration.mjs` (synthetic pathological world + preflight-abort
  case) AND by live migration of the real volume DB (827/827 placements, zero dangles,
  clean foreign_key_check) before the volume reset.
- **Choke point** — `src/server/stock.ts`: `reserveStock/releaseStock/
  consumeReservedStock/consumeFreeStock/restoreStock/guardedRecountStock/ensureStock`,
  all on the proven guarded read-check-write pattern; `assertStockMutable` is the
  no-op Round-3 freeze seam (cutoff model A2 documented at the seam). No count math
  exists outside this module — and tsc now enforces the model wholesale (the old Lot
  columns are gone from the generated client).
- **Sweep** — order (cart/reserve/pickup per placement; Take.pantryId snapshotted),
  take.undo (restores the original placement by (lotId, pantryId)), shares (posts link
  placements; gift = consumeFreeStock, still $0/no-ledger), adjustments (stockId
  inputs, rows carry lot+stock), restock finalize (ensureStock birth) / void (zeroes
  placements, reservation guard intact), connection sever release, shopping FIFO
  badges, four SSR pages + inventory-view. Money paths byte-for-byte semantics.
- **e2e teardown fix** — raw-SQL cleanups in contacts/onboarding specs now delete
  Stock rows before Lot/Restock (Stock RESTRICTs Lot deletion).
- **Gate — green:** unit 219/219 · tsc/eslint/lint:tokens clean · verifier all-ok ·
  full both-engine e2e vs fresh rebuilt stack **386 passed / 0 failed / 2 flaky
  (retry-green, pre-existing) / 6 skipped**. Codex review findings (preflight, share
  unique key, teardowns) folded in; deferred: legacy adjustment clientKey replay
  across the deploy boundary (accepted risk), receivedCount-filter observation
  (hoisted above).

## Share circle-scoping — per-post audience override (2026-07-08)

Aaron's ask: entity-level "visible only to these circles" overrides. Recon showed items/
pantries/memberships ALREADY have the full ALL/SELECT/PRIVATE control (Phase 2 P4 —
the pill in the detail headers); products deliberately skipped (pantry-level suffices).
The genuinely missing piece was **individual shares** — grant-only until now. Team build
(server GPT-5.5/codex · UI Opus 4.8 · e2e GPT-5.5 · Fable coordinating + codex review).

- **Schema** — additive `20260708090000_share_circles`: `SharePost.visibility`
  ("ALL" default | "SELECT") + `SharePostCircle` join (mirrors PantryCircle/ItemCircle).
- **Semantics** — a viewer sees a SELECT post iff `shareVisible` AND the poster-side
  circle on their connection is among the chosen set (same owner-circle direction as
  items/pantries). Enforced at: feed, post-time notify fan-out, both claim paths
  (out-of-scope = 404, never leaks), withdraw/respond FORBIDDEN-vs-404 branches, digest
  "new shares" count, and the reshare chain-liveness walk.
- **Reshares refused on scoped posts** — a reshare copy's audience is recomputed from
  the resharer's connections, so origin scope can't carry; `canReshare` false + mint
  rejects (CONFLICT). Reshare copies of ALL posts stay ALL. Composer pins hops to 0 in
  SELECT mode and disables the pass-it-on select ("No — limited posts stay put").
- **UI** — composer "Audience" section (radio: "All sharing circles" default / "Only
  these circles…" + checkbox list of shareTo circles via the newly-flagged
  `circle.names`; hidden when no shareTo circles; ≥1 required to post); "Some circles"
  chip on the poster's own scoped posts; small print "Limited posts can't be reshared."
- **Server extras from the slice** — circle delete guard now counts SharePostCircle
  scope rows; `share-reach.ts` gained the pure scoped-visibility helpers (unit-tested)
  so the digest never imports routers.
- **Codex review found 3, all fixed at integration:** (1) HIGH `share.respond` could
  confirm a claim on a reshare copy whose upstream chain had died (pre-existing B6/F4
  gap, widened by scoping) — respond now re-checks `chainEdgesAlive`; (2) digest counted
  dead-chain reshare copies — now prunes them (chain helpers moved to share-reach.ts);
  (3) the e2e audience helper had a fallback that masked testid-contract drift —
  testid moved to the row per contract, helper made strict.
- **Gate — green:** unit 219/219 · tsc/eslint/lint:tokens clean · migration proven on a
  scratch DB · full both-engine e2e **388 passed / 6 skipped / 0 failed** pre-polish and
  re-run post-polish · 390px light+dark screenshots in `.playwright-mcp/share-circles/`.
- Backlog note: **recipes** remain the one entity type without circle SELECT (binary
  `private` flag only) — added here rather than REWORK since it's an observation, not a
  decision.

## Media round follow-up — iOS photo picker + labels dropped (2026-07-07, Aaron's device feedback)

- **iOS photo library**: the item-create and gallery-add file inputs carried
  `capture="environment"`, which on iOS forces the camera and hides the photo-library
  option. Removed (the OS now offers Take Photo / Photo Library / Choose File).
  Deliberately kept camera-first: receive-wizard receipt/unit photos, shares.
- **Photo labels dropped** ("not as useful as I thought"): chips, the Label dropdown,
  both `setLabel` mutations, and label inputs removed from UI/routers/e2e. The
  `label` column stays in ProductImage/ItemImage (always null, commented DORMANT) so a
  re-add is router+UI only, no migration. This also moots the label-chip-truncation
  cosmetic from the media round.
- **Gate — green**: tsc/eslint/lint:tokens clean, unit 216/216, full both-engine e2e on
  a rebuilt stack **376 passed / 2 flaky (retry-green, pre-existing) / 6 skipped / 0
  failed**.
- **Deploy postscript (same day):** Aaron's production upload hit a bare **413** — the
  README's nginx example never set `client_max_body_size`, and nginx's 1MiB default
  rejects photo/PDF uploads at the proxy. Runbook example now carries
  `client_max_body_size 25m` (app caps: 8MiB images / 20MiB attachments; Caddy has no
  default limit, needs nothing).

## Media round — product/item galleries, attachments, linkified notes (2026-07-07)

Multi-photo galleries for Products and loanable Items (main = position 0, optional preset
label chips nutrition/ingredients/angle), PDF attachments on items (user manuals), and
URL auto-linking in item notes. Team build: server slice GPT-5.5 (codex), UI slice
Opus 4.8, e2e slice GPT-5.5, Fable coordinating/integrating + codex second-opinion review.

- **Schema** — migration `20260707150000_product_item_media`: `ProductImage`/`ItemImage`
  (position-unique per parent; **main = position 0**; label preset) + `ItemAttachment`
  (path/name/sizeBytes); `Item.photoPath` dropped via table rebuild with backfill into
  `ItemImage(position=0)`. Item notes cap 500 → 2000.
- **Server** — `product` gains its first mutations (get/addImage/removeImage/setMain/
  setLabel; `receiveStock`, owner-only, 404-before-403) with `product.get` reach =
  owner's pantry grant + a FINALIZED lot in a pantry visible to the viewer (the derived
  fallback photo is computed only from lots the viewer can see); `item` gains the same
  gallery mutations + add/removeAttachment (`lendBorrow`; cap 8 photos / 5 attachments);
  setMain renumbers via a negative-offset two-pass inside `dbTransaction` (unique index
  stays valid); shared pure `media-positions.ts`. New image kind `products`; attachments
  upload path (`%PDF` magic, 20 MiB, `?name=` sanitized) + session-gated
  `/api/attachments/[...path]` (inline PDF, nosniff, immutable-private). Sweep covers all
  three new tables + both new dirs. Derived-photo rule unchanged as fallback: explicit
  main → else newest lot unit photo (D8 amended, not removed).
- **UI** — shared `MediaGallery` (hero + thumb strip + label chips + owner controls);
  product photo sheet in pantry browse (📷 button on the product row; read-only for
  connected viewers); item detail gallery + "Manuals & documents" + inline
  autosave-on-blur notes textarea with live `<Linkified>` preview
  (`src/app/linkified.tsx` — React-element linkification, http/https only,
  trailing-punctuation-safe, no dangerouslySetInnerHTML).
- **Integration fixes** (coordinator): stripped the server slice's deprecated
  `photoPath` shims once the UI stopped reading them; restored `item.update`'s
  non-owner rejection to **403** (codex had changed it to 404 — a visible item you
  can't edit is a capability failure; slice6 asserts it); ported slice6's photo-pipeline
  spec from the removed single-photo API to the gallery mutations (same invariants);
  e2e helper passed the attachment display name via `?name=` (multipart filename is
  deliberately ignored); scoped notes assertions to the new `item-notes-display` block
  (owner textarea + preview both contain the raw text); added Content-Disposition/
  nosniff/file-unlinked-after-remove assertions per the codex review finding.
- **Ops note:** the "thin sonnet wrapper for codex" pattern failed — the wrapper
  spawned three concurrent codex processes against the shared checkout and stopped
  early. Killed them (tree was still clean) and ran `codex exec` directly from the
  coordinator as a tracked background task; that worked first try for both codex slices.
- **Cosmetic follow-up:** thumb label chips truncate at 390px ("Nutrition f…") — full
  text stays in the DOM/a11y and the owner's Label dropdown; consider a hero-adjacent
  chip or shorter display copy later.
- **Gate — green:** unit 216/216 · tsc/eslint/lint:tokens clean · migration proven by
  `prisma migrate deploy` on a scratch DB · full both-engine e2e on the rebuilt stack
  **378 passed / 6 skipped / 0 failed** (real playwright exit code) · 390px light+dark
  hand-check screenshots in `.playwright-mcp/media/`.

## Docs re-sync + PLAN split (2026-07-07)

Full documentation sync to the running app (everything but PLAN.md was frozen at
2026-07-04/05, predating Phase 3 and/or Rounds Q–T), driven by a four-way staleness
audit. No feature work; three source files got comment-only fixes.

- **SPEC.md** — status/§3/§7 rewritten (Rounds 2–4 + notifications were still listed as
  "designed but not built"); Connection re-documented around **circles** (the edge-grant
  model it described was replaced in Phase 2); pantry/item `shared` → visibility;
  domain blocks added for shares/recipes/planner + contact/notifications; auth gains
  verification/reset/MFA. The §4 money/goods core was verified accurate and untouched.
- **Blueprints** — 01: reach mechanism rewritten around circles, migrations list brought
  current (9 missing), dated Phase 2/3 model sections appended; **all 12 money
  invariants byte-identical**. 04: new §6–§9 (mail, MFA crypto, notifications/digest/
  scheduler, deep links), §5 + env block rebuilt from the real files. 02: the ten
  missing screens/flows + the back-stack nav model; 00: Decision 9 rewritten (the "two
  push events, no schedulers" claim was false on both halves); 03: two cosmetic fixes.
- **PLAN.md split** — pre-Phase-2 history (v1 slices, 07-03 iteration rounds, rework
  design note, Rounds 1–4) moved verbatim to `docs/plan-archive.md`; live items hoisted
  to "Outstanding work" at the top; cross-refs re-pointed.
- **REWORK.md** — gained the **canonical deferred list** (CLAUDE/PLAN point at it);
  the pre-Phase-3 deferral list back-annotated (notifications + per-invite presets
  shipped); **N5 amended to the shipped circle default (push ON / email OFF)** —
  decided with Aaron: the code's default is the decision of record.
- **README/compose** — `APP_BIND`/`APP_PORT`/`COOP_DATA` + `MAIL_PUBLIC_URL` documented
  (unset, a self-hoster's email links point at potluckmutualaid.app); `.env.example`
  compose-overrides section; **fix: `TRUSTED_PROXY_HOPS` was documented + read by code
  but never passed through compose** — now in the environment block.
- **Stale code comments fixed** (no behavior): `push.ts` header ("exactly two events"),
  `share.ts` circle-default note, `recipes/[id]/page.tsx` ("own recipe opens the
  editor"), `nav-history.tsx` intro ("go `router.back()`").
- `docs/research/federation.md` got a historical banner (checklist items 2/4 shipped).
- **Gate — green:** unit 202/202 · lint:tokens + eslint clean · `tsc --noEmit` clean ·
  full both-engine e2e on a rebuilt stack **366 passed / 6 skipped / 0 failed** (7.2m).

## Round T follow-up — back-stack loop + Cook-view notch (2026-07-06)

**Done** (Aaron's report: Cook → Done → the view's back button bounced BACK to Cook; and
the Cook view's header sat under the iOS status bar).

- **The back-stack loop, two layered causes**: (1) NavTracker recorded every navigation
  as forward, so a Done-style A→B→A round trip pushed a loop — it now **collapses a
  return to the immediately-previous page as a POP**; (2) deeper, `BackLink` called
  `router.back()`, which replays BROWSER history — after Done's push the browser history
  still holds the forward hop, so back() bounced to /cook no matter what the stack said.
  BackLink now navigates **explicitly to the stack's previous entry** (router.push),
  never router.back() — the stack is the single source of truth for in-app intent, at
  the cost of slightly deeper browser history. Regression e2e added (view → Cook → Done
  → back lands /recipes) — it faithfully reproduced the bug against the first
  (tracker-only) fix, which is what exposed cause 2.
- **Cook-view notch**: the view is `fixed inset-0` (covers the app header, which owns
  the safe-area inset) — its own header now carries `pt-[max(0.75rem,
  env(safe-area-inset-top))]`, same pattern as /login and /invite.
- **Gate — green**: nav-back 10/10, full both-engine e2e **366 passed / 0 failed**.

## Round T — dvh tab bar, circle-picker household invite, vCard copy (2026-07-06)

**Done** (Aaron's trickle-ins). No schema change.

- **Tab bar riding up on short pages** (iOS Safari in-browser only; the installed PWA was
  never affected): the height chain was percentage-based, which resolves against the
  toolbar-expanded viewport and never grows when Safari's toolbar collapses — `fixed
  bottom-0` anchored to that stale layout viewport. Fix: body `min-h-full` → **`min-h-dvh`**.
- **"Invite a NEW household" now picks a CIRCLE** (was six per-grant checkboxes — the
  deferred "per-invite grant presets" closed): the same CirclePicker as connect/accept/
  move, **Friends preselected** (one-click mint preserved). `invite.createHousehold`
  accepts `{circleId}` (inviter-owned, the circle's CURRENT grants snapshotted into
  grantsJson at mint) alongside legacy `{grants}` — old invite links + RPC callers keep
  working; `joinViaInvite` untouched. Snapshot-at-mint semantics recorded as deliberate
  (live-circle semantics would need an Invite.circleId column — deferred).
- **"Save contact" → "Save contact to device"** (the vCard button pulls data out of the
  app; the label now says so).
- **Gate — green**: unit 202/202, full both-engine e2e **364 passed / 0 failed** on a
  fresh stack. Ops note (corrected): t-e2e looked stalled (idle pings, hour-old `-p`
  stack) so the coordinator gated the landed tree directly — but it was actually mid
  long-running full-suite verify, which ALSO came back 364/0 green on its own stack.
  Two independent green full runs; the verify-state-directly rule still applied
  correctly (the tree was gate-ready), just with a wrong stall diagnosis.

## Round S — plan/shopping: Add from Plan, added-to-list tracking (2026-07-06)

**Done** (the last of Aaron's 2026-07-06 batch). One additive migration
`20260706120000_plan_shopping_tracking` (`PlanEntry.addedToShoppingAt DateTime?`).

- Shopping's "Generate" button reads **"Add from Plan"** (testid/procedure unchanged).
- **Added-to-list tracking**: range-generate and the new per-entry add both stamp the
  consumed recipe entries in-tx; the plan week returns the stamp and EntryRow shows a
  🛒✓ "On the shopping list" indicator (`plan-entry-in-list`).
- **Per-entry add**: the plan entry sheet's "Add to shopping list"
  (`plan-entry-add-to-list`) → NEW `shopping.addFromEntry({planEntryId, clientKey?})` —
  built on an EXTRACTED shared core (`src/server/shopping-generate.ts`:
  `bucketPlanEntries`/`upsertBuckets`, used by both generate and addFromEntry so the
  merge logic can't drift). Guards: cross-household 404, note/item 400.
- **Semantics decision (argued and settled)**: re-adding an entry is **IDEMPOTENT** —
  the core recomputes the entry's need (one planned lasagna needs 4 cups no matter how
  many times it's sent); cleared rows are re-created; nothing is ever silently removed
  (the real PTE invariant). The coordinator's initial accumulate ruling was reversed on
  s-e2e's architectural argument (generate's tested idempotence shares the core).
- **Gate — green first try**: unit **202/202**, full both-engine e2e **360 passed / 0
  failed** on a fresh stack; s-e2e self-verified 22/22 twice on an isolated `-p` stack;
  s-ui browser-verified idempotent re-add + dark scheme. Wire note: no tRPC transformer,
  so the stamp is an ISO string client-side.

## Round R — recipes: view page, Cook view, URL image import (2026-07-06)

**Done** (Aaron's asks, modeled on Plan to Eat — research summary in the 2026-07-06
session). No schema, no deps.

- **Read view**: `/recipes/[id]` was a router that dropped OWN recipes straight into the
  edit form (no read view existed). Now a unified `RecipeView` for own+shared (photo,
  meta, servings stepper + live-scaled ingredients, directions as NUMBERED steps via the
  shared `steps.ts` splitter, source link) with **Cook** (always), **Edit** (own →
  NEW `/recipes/[id]/edit`), fork (shared — testid/behavior preserved for the existing
  spec). shared-recipe-view.tsx folded in. Plan's entry sheet gained "View recipe →".
- **Cook view** (`/recipes/[id]/cook`, the PTE-informed centerpiece): split pane —
  current step in large type + counter on top, independently scrollable tap-to-check
  ingredient list below; swipe (pointer events) + big prev/next + Space/arrow keys;
  servings stepper (scale.ts reuse); **screen wake-lock** (feature-detected,
  visibilitychange reacquire); sessionStorage step persistence per recipe; aria-live
  step region. Steps = newline/paragraph split, numbering-prefix stripped. Works for
  shared recipes.
- **Import image**: the JSON-LD `image` URL was already extracted and DROPPED — now
  `recipe.importUrl` downloads it server-side (`guardedImageFetch`: same SSRF guard,
  image/*, 4MB cap, **JPEG-magic required** — deliberate v1, no server image codecs) with
  **og:image/twitter:image fallback** + relative-URL resolution, stores via a new
  `writeImageFile` (32hex.jpg — passes the fresh-photo save validation), returns
  `photoPath` which the editor drops into the photo control (replace/remove = the PTE
  review insurance); a found-but-unfetchable photo shows `recipe-import-photo-note`.
  A SEED_DEMO-gated sentinel fixture (`fixture.potluck.test/import/*`) is the e2e seam
  (extraction-fixture precedent); the boot orphan sweep covers abandoned imports.
- **Integrator fix** (r-e2e's find): recipe.update never invalidated the per-id
  `recipe.get`, so editing then soft-navigating back to the NEW read view showed stale
  content ≤30s — invalidate now clears both.
- **Gate — green first try**: unit **196/196**, full both-engine e2e **354 passed / 0
  failed** on a fresh stack; own-eyes Cook pass (light 390px + dark desktop, ArrowRight+
  Space advanced the step, check-off strike verified). r-e2e self-verified 34/34 on an
  isolated `-p potluck-e2e` :3200 compose (the APP_PORT override earning its keep).

## Round Q — quick fixes + navigation review (2026-07-06, Aaron's device feedback)

**Done.** Six fixes from real-device testing. No schema, no deps.

- **Phone backspace** (`formatUsPhoneEdit` in src/lib/phone.ts): the formatter re-appended
  punctuation from digit count, so deletes were undone — a deletion that removed only
  punctuation now also drops the preceding digit; backspace erases all the way to empty.
- **Empty digest suppressed**: `digestFor` returns `reason:'nothing-to-report'` (no
  watermark stamp) when every household section has no standings/loops/new-shares.
- **Items header** standardized to the shares/recipes idiom (back link + truncate title +
  caption); kept its deliberate lg two-column layout.
- **Recipe editor mobile overflow**: `min-w-0` on all flex label rows + `w-full min-w-0`
  inputs (servings/yield, prep/cook, course/cuisine) — no horizontal scroll at 390px.
- **iOS notch**: the safe-area top inset lived on BODY (content padding), so the sticky
  header pinned under the status bar when stuck — moved to the header itself
  (`pt-[env(safe-area-inset-top)]`); headerless /login + /invite carry their own
  `max(1.5rem, inset)` padding. FOLLOW-UP: the receive wizard (also headerless) still
  starts at y=0 on notch devices — locate its top wrapper and add the same inset.
- **Navigation review**: every back arrow was a hardcoded href (zero router.back() in the
  app). New `src/app/nav-history.tsx` — a sessionStorage nav stack (NavTracker in the
  layout) + `BackLink({fallback})` that goes BACK when in-app history exists and to the
  fallback on deep links. Applied: recipes→/home, items→/home, shares→/, shopping→/plan,
  pantry inventory→/home (was stale `/`), contact page→/more. **Plan's arrow removed**
  (top-level tab; orphaned pl-8 cleaned). Single-parent detail pages stay hardcoded
  (deliberate).
- **Gate — green**: unit 175/175, full both-engine e2e **350 passed / 0 failed** on a
  fresh stack; 390px screenshots of Items/Plan verified. Gate notes: an integrator JSX
  comment briefly broke the build (q-dev caught it — comments in a return must not be
  sibling expressions); slice7's safe-area assertion updated body→header (the intended
  change); digest-cadence fixtures gained real content (the empty-suppression exposed that
  its digests had nothing to report — they only "sent" because digests always sent).

## Profile polish — avatar crop, US phone formatting, TZ auto-detect (2026-07-05)

**Done** (Aaron's asks). No schema, no migration, no new deps.

- **Avatar cropper** (`src/app/avatar-crop-sheet.tsx`, net-new — the repo had zero
  pointer-gesture code): a circle-mask viewport over the picked photo; Pointer Events on a
  `touch-none` stage — one pointer pans, two pinch-zoom (phones), wheel zooms (desktop),
  plus an always-visible slider (min = cover, max 5×; the accessible path). Offset clamped
  so the image always covers the circle. Save canvas-crops to **512×512 JPEG q0.85** into
  the EXISTING upload pipeline (`uploadImage('avatars')` → JPEG-magic/8MB route →
  `assertFreshAvatar`) — server contract untouched, container stays native-dep-free.
- **US phone formatting**: pure `src/lib/phone.ts` (`formatUsPhone` as-you-type
  progressive `(913) 555-0142`, non-US passthrough; `phoneDigits`; `phoneHref` E.164-ish).
  The profile input is `inputMode="tel"` + formatter-controlled (fixes Aaron's "phone
  keypad can't type parens/dashes"); stored value = the formatted string (schema stays
  free text). **Latent wart fixed:** `tel:`/`sms:` hrefs and the vCard TEL interpolated
  the raw string — now `phoneHref`-normalized (`tel:+19135550142`;
  `TEL;TYPE=CELL:+1…`).
- **Timezone — quiet auto-detect, deliberately nothing more**: first-run consent (Save
  AND "Not now") captures `Intl.DateTimeFormat().resolvedOptions().timeZone` when unset,
  so digests fire local instead of the UTC fallback with zero UI; the prefs "Server
  default" option labels the detected zone. NO instance/household TZ, no locale plumbing
  — connections are physically co-located (Aaron), and per-user detection already covers
  a future multi-region instance.
- **Gate — green.** typecheck + lint:tokens clean, unit **171/171**, full both-engine
  e2e **341 passed / 0 failed** on a fresh `down -v` stack; cropper hand-verified against
  the prod build in light-desktop + dark-390px (drag + slider). Two stale contacts.spec
  expectations of the OLD raw-phone behavior updated at the gate (vCard TEL normalized;
  profile edit now types 10 digits and expects the formatted round-trip).

## Digest cadence + in-process scheduler (2026-07-05, post-Phase-3)

**Done.** Aaron's asks: a daily digest option (weekly kept but demoted), per-user send
time, an app-thread scheduler instead of cron — plus a mid-round product-direction call:
**nothing defaults to weekly, and shares reach people immediately.** Migration
`20260705200000_digest_cadence` (adds `digestCadence`/`digestHour`/`digestWeekday`,
drops `digestOptOut` via the table-rebuild dance, data-preserving; opted-out → 'off',
everyone else → the new 'daily' default).

- **Per-user cadence** off/daily/**daily-default**/weekly + send hour (0–23) + weekday
  (weekly only), on the Notifications screen (cadence/hour/weekday selects; timezone
  gated on cadence ≠ off). `runDigest` generalizes to per-user windows (daily = local-day
  idempotency, weekly = chosen-weekday window); the digest's "new shares" span follows the
  cadence (24h/"today" vs 7d/"this week"). `/unsub` digest → cadence 'off'.
- **Default flips (Aaron):** `digestCadence` defaults **daily** — a weekly default would
  surface perishable shares 6 days late, gutting the point; and the **circle category now
  defaults `{push:true, email:false}`** — a new share pushes to visible connections
  IMMEDIATELY (the app's goal is regular IRL interaction; leftovers are best tonight),
  while per-share email stays off (the daily digest is the email channel — an email per
  zucchini would bury the email-native users). Reverses Round-C's digest-only share
  default deliberately.
- **In-process scheduler** (`src/instrumentation.ts`): a ~10-min `setInterval` armed at
  boot (`DIGEST_SCHEDULER` default on; `off` → the `scripts/run-digest.ts` cron fallback),
  try/catch-wrapped (never blocks boot), in-flight guard, `unref()`ed, no boot-tick.
  Structural fix en route: the scheduler's import of digest.ts dragged the tRPC/argon2
  layer into Next's edge instrumentation bundle (build break) — the pure helpers digest
  needs were extracted to trpc-free `src/server/open-loops.ts` + `share-reach.ts`
  (routers re-export; external API unchanged).
- **Gate — green.** typecheck + lint:tokens clean, unit **159/159** (13 new `digestDue`
  cases incl. TZ), full both-engine e2e on a fresh `down -v` stack: **336 passed / 6
  skipped / 0 failed**; scheduler-armed boot log verified. Two integrator fixes at the
  gate: the Round-C `defaults.unit.test.ts` still asserted circle off/off (updated to the
  new matrix), and Round-A's `mail.spec` subscription test used a synthetic
  `userId:'e2e-mailtest'` that the now-**fail-closed** `subscriptionAllowed` (unknown user
  → no send — the right production semantics, kept) correctly skips — the test now
  resolves a real seeded user id.

## Phase 3 Round D — deep-link routing (2026-07-05) — PHASE 3 COMPLETE

**Done, and with it all four Phase-3 rounds.** Notification taps now land on the specific
actionable screen AND switch to the right acting household (docs/REWORK.md N7). **No schema** —
the deep-link token is stateless HMAC. Zero money paths. Three-teammate team.

- **Navigation-only deep-link token** (`src/server/deeplink.ts`): `mintDeepLinkToken({path,
  householdId})`/`verifyDeepLinkToken` — base64url `{p,h,e}` + HMAC keyed by a **domain-separated**
  derivation of `MAIL_UNSUB_SECRET` (`update('deeplink-v1')`), 24h inline TTL, stateless. A hard
  **open-redirect safe-path guard** (`isSafePath`: single leading `/`, rejects `//`, `/\`, any
  backslash/`@`/control/space) at mint (throws) AND verify (→null); proven fail-closed by 6 unit
  tests (`//evil`, `https://evil`, `\\evil`, `/x@y`, `javascript:`, unrooted, empty). It is
  **navigation-only** — never accepted as auth, grants nothing but a redirect + own-household switch.
- **`/go` route** (`src/app/go/route.ts`, GET): verify → invalid/expired/tampered/unsafe →
  `redirect('/')`; **logged-out → `redirect('/login?next=' + enc('/go?t='+token))`** (so the
  household-switch survives login — you re-hit /go authed after signing in); **logged-in →
  `setActingHouseholdCookie` ONLY if the token's householdId is one of the viewer's memberships**
  (re-checked server-side — the token is a hint, not authz), then `redirect(path)`. Never
  authenticates, never mutates.
- **Email deep-links are new** — Round C's notify() email branch + digest carried NO link;
  now notify() mints a per-recipient `/go?t` token (householdId = recipient's OWN household) used
  for the push url AND a new `Open Potluck: <link>` email CTA (text + escaped html anchor); the
  digest CTA targets `/activity`. Order targets upgraded `/orders` → `/orders/[id]`.
- **Login `next=` continuation** (was greenfield — every login hardcoded `/`): `login/page.tsx`
  validates the `next` searchParam (safe-relative only; unsafe → `/`) and passes it to
  `login-form.tsx`, which `router.push`es it on login success AND after the MFA challenge.
  An already-authed hit on `/login?next=` honors the safe next.
- **Gate — green.** typecheck + lint:tokens clean, unit **146/146** (+6 deeplink), full
  both-engine e2e on a fresh `down -v` stack: **326 passed / 6 skipped / 0 failed**, no flakes.
  The household-switch e2e is self-proving: `/orders/[id]` 404s for a non-involved household, so
  the page is only reachable if the switch fired. Open-redirect e2e: `?next=https://evil.com`
  after login lands `/`, never the external host.
- **Follow-up (deferred, cosmetic):** the Round-B per-factor MFA router aliases — unify to
  canonical begin/confirm/disable({method}) + migrate the card email, then drop the aliases.

## Phase 3 Round C — notification preferences + push matrix + digest (2026-07-05)

**Done. The notification system** (docs/REWORK.md N4/N5/N6). Migration
`20260705180000_notifications` additive (`NotificationPreference` per (user,category) +
User `timezone/digestOptOut/showDetails/lastDigestAt/notifyOnboardedAt`). Three-teammate
team, coordinator-integrated. Zero money paths.

- **Per-user preference matrix** — three categories with per-channel push/email toggles:
  **pickups** (order requested/ready, share claimed, connection request — default push+email
  ON), **circle** (new share posted — default OFF, digest instead), **ledger** (settlement/
  adjustment — default OFF, in-app + digest). `account` (verify/reset/mfa) stays transactional,
  never in prefs. Absent pref row = the category default; `setChannel`/`/unsub` initialize
  BOTH channels to the category default on first write so flipping one never zeroes the other.
  A per-user weekly-digest opt-out + a `showDetails` privacy toggle (default off) + optional
  timezone. First-run consent modal (once per account, `notifyOnboardedAt`).
- **Generalized push** — `notifyLedgerEvent` became a `notify({recipientHouseholdIds,
  excludeUserId, category, url, title, body, detail?})` layer that resolves recipient members,
  checks each user's prefs, and sends push (Web-Push-encrypted) + email (Round-A subscription
  pipeline) per channel. Wired into the 5 real events (order.submit/markReady, share.claim/
  create, connection.request). **N4 content rule:** title/body carry a `{household}` stamp of
  the RECIPIENT'S OWN household name only — never a counterparty name, dollar, or address;
  `showDetails` opt-in appends the counterparty household name to the body.
- **Weekly digest** — `runDigest`/`digestFor` assemble balances (`netByCounterparty`), open
  loops (factored `openLoopsFor` out of activity.list, byte-identical), and new-shares-this-week;
  sent via the subscription pipeline with a List-Unsubscribe header, idempotent per weekly
  window. `/unsub` RFC-8058 one-click route (HMAC verify, no session); `MAIL_UNSUB_SECRET` prod
  entrypoint guard (Round-A follow-up **closed**). Production digest = external cron (README).
- **DELIBERATE N5 change:** settlement/adjustment no longer push by default (money = in-app +
  digest); opt-in restores push. slice7 reconciled to enable the pref then assert.
- **Gate — green.** typecheck + lint:tokens clean, unit **140/140** (+ defaults + unsub-token
  suites); notify-server's in-container proof **36/36**; notify-ui browser-verified light+dark
  (prefs matrix + first-run consent persist). Full both-engine e2e on a fresh `down -v` stack:
  **318 passed / 6 skipped / 0 failed**.
- **The gate lesson — a global blocking modal breaks the whole suite in two waves.** The
  first-run consent modal is a `fixed inset-0` overlay; it intercepts every pointer event for
  any un-onboarded account. Wave 1: seeded accounts booted un-onboarded → fixed by seeding
  `notifyOnboardedAt` (same shape as Round B's verified-banner seed). Wave 2 (only the re-gate
  exposed it): accounts CREATED mid-test via browser invite-acceptance boot un-onboarded too →
  timed out → incomplete `finally` → a leaked `Ferris (e2e)` household + stray connection →
  **cascade** of "unrelated" order/settle/lending failures (all read ledger net through the
  broken topology). Fixed with Playwright `page.addLocatorHandler` (`autoDismissFirstRun`)
  armed in `login()` + the two register-form guests — auto-dismisses the modal wherever it
  appears, no-op when onboarded. Takeaway: a new app-wide blocking overlay must be handled in
  the shared test harness, and a mid-test timeout that skips teardown cascades across the
  workers:1 shared DB.
- **Follow-up (still deferred):** unify the MFA router's per-factor aliases (Round-B cosmetic).

## Phase 3 Round B — auth flows: verification, reset, MFA (2026-07-05)

**Done. Email verification + password reset + MFA on the Round-A mail substrate**
(docs/REWORK.md N8/N10). Migration `20260705140000_auth` additive (User gains
emailVerifiedAt/totpSecret/totpEnabledAt/totpLastStep/mfaEmailEnabled;
EmailVerificationToken/PasswordResetToken/MfaBackupCode/EmailMfaCode). Built by a
three-teammate team (auth-server / auth-ui / auth-e2e), coordinator-integrated. Zero
money paths.

- **Server (reviewed clean by the coordinator):** enumeration-safe verify + reset (DUMMY_HASH
  on missing user; identical `{ok:true}` even when throttled; all token failures read
  generic); single-use short-TTL tokens hashed at rest via `updateMany(usedAt:null)` claim
  guards; **a TOTP-enrolled account's password reset must clear a code in the same call —
  no TOTP bypass** — and revokes every session on success. **MFA:** TOTP (secret AES-256-GCM
  encrypted at rest via `MFA_ENC_KEY`; enroll→confirm-live-code→one-time backup codes;
  monotonic `totpLastStep` replay guard) + emailed codes (6-digit, single-use, request cap
  3/15min + attempt cap `EMAIL_MFA_MAX_ATTEMPTS`=5); a login discriminated union
  (`{mfaRequired,pendingToken,methods}` vs `{id,name}`) with an HMAC-signed 5-min pending
  token (domain-separated, timing-safe, NOT a session); **admin-required TOTP** enforced on
  the admin action + surfaced via `mfa.status.adminMustEnroll`; audited admin MFA-reset.
  Entrypoint refuses a non-demo boot without a real `MFA_ENC_KEY` (dev key injected under
  SEED_DEMO). **N10:** durable fixture TOTP — `aaron` boots enrolled with a fixed secret
  (stable across reseed), `scripts/dump-demo-creds` emits 1Password-importable otpauth URIs.
- **Gate — green.** typecheck + lint:tokens clean, unit **128/128** (18 new MFA-crypto/totp/
  backup/email-code tests). Full both-engine e2e on a fresh `down -v` fixture stack:
  **300 passed / 6 skipped / 0 failed (5.8m)**, no flakes — the both-scheme functional proof
  incl. enroll→logout→challenge-login, reset-with-code, emailed-code cap, admin-required.
- **The big lesson — a TOTP-enrolled account can't be a rapid-repeated-login test fixture.**
  A TOTP code is single-use per 30s step (the anti-replay guard); the suite logs in as the
  enrolled `aaron` ~230 times, far more than there are distinct windows, so a first pass had
  **224 failures / 48 min** — every same-window aaron login replay-rejected. Fix (Option B,
  Aaron-approved): a **SEED_DEMO-only `/api/dev/mfa-reset-step`** route clears `totpLastStep`;
  `login()`/`apiLogin()` call it before aaron's SETUP challenge, and the 3 dedicated MFA
  tests clear it before each must-succeed challenge but NEVER before the replay-rejection
  assertion (which must stay guarded). Production is untouched — the route 404s off a demo
  stack, and the guard is fully exercised by the ephemeral-account tests.
- **Coordination note (freeze rule, again).** During the integration gate auth-server edited
  `mfa.ts` + the `test:unit` line and created-then-deleted a stray root `scratch-proveit.ts`
  (a root `.ts` breaks `next build`), which made my typecheck results fluctuate across runs.
  Caught via file mtimes, locked it down, gated the stable state. Reinforces: **nothing edits
  the tree during a gate.**
- **FOLLOW-UPS (deferred, not blockers):** (1) the MFA router carries redundant per-factor
  aliases (`beginTotp/confirmTotp/beginEmail/confirmEmail/disableEmail`) auth-server added
  mid-gate to keep the build compiling — canonical `begin/confirm/disable({method})` is the
  intended surface (the card's TOTP path + all e2e use it; the card's EMAIL section still
  rides the aliases). Unify the card email + drop the aliases. (2) Round C's `/unsub` route
  must require a real `MAIL_UNSUB_SECRET` in prod (Round-A follow-up).
- **Live email still blocked (external, not code).** `no-reply@` — and now even the
  previously-working `testuser1@` — return DreamHost `535` after the cooldown: cumulative
  failed-auth attempts across the session left the sending IP/account under an active
  brute-force throttle. Stopped all auth attempts to let it fully cool (untouched, hours).
  Round B gates entirely in **MAIL_MODE=capture** (green); live verification/reset email
  validation waits for the block to clear AND for `no-reply@`'s credential to be confirmed.

## Phase 3 Round A — mail infrastructure (2026-07-05)

**Done. The mail substrate for the notifications phase** (design record: docs/REWORK.md
"Phase 3", N1–N11). No user-facing surface yet — Round A is the transport layer the auth
flows (Round B) and notification prefs/digests (Round C) ride on. Built by a two-teammate
team (mail-server: server + schema + guards; mail-e2e: tests) against a fixed contract,
coordinator-integrated. New migration `20260705100000_mail` (additive — `CapturedEmail`
audit table + `MailSuppression`; no money paths touched).

- **Swappable transport + two deliberately separate pipelines.** `mailConfig()` mirrors
  `vapidConfig()` (null when EMAIL_* incomplete; nodemailer over DreamHost, 587/STARTTLS).
  `sendTransactional` (verify/reset/mfa) carries NO `List-Unsubscribe` and never consults
  prefs/suppression — you can't unsubscribe from your own password reset. `sendSubscription`
  (digests/shares) carries RFC-8058 `List-Unsubscribe` + `List-Unsubscribe-Post` and gates on
  suppression + a per-user prefs hook BEFORE delivery. The two are separate exported functions
  so they can't be confused at a call site. Round-C hook signatures fixed now
  (`isSuppressed` queries the real table; `subscriptionAllowed` stubs true).
- **Fail-closed dev mail-capture** (the leakage guard, N9). Pure `resolveRecipients` (modeled
  on `isAllowedPushEndpoint`): production delivers as-is; else allowlist-regex match delivers,
  non-match + redirect → redirected with `X-Original-To`, non-match + empty redirect →
  capture-only, empty/empty → nobody gets real mail, malformed regex → non-matching (never
  opens the gate, never throws). `[Potluck Dev]` subject prefix dev-only. Every attempted send
  writes a `CapturedEmail` row regardless; real SMTP only in `MAIL_MODE=live` past the filter;
  SMTP errors logged+swallowed (never break the caller). Boot guards clone the VAPID
  refuse-to-start block: FATAL on `SEED_DEMO=1 + MAIL_MODE=live + MAIL_PRODUCTION=1`; loud WARN
  on prod+capture; `MAIL_MODE` defaults capture.
- **Gate — green.** Static: typecheck + lint:tokens clean, unit **110/110** (incl. 14 new mail
  tests: the fail-closed dev-filter matrix + the RFC-8058 header/token contract). Full
  both-engine e2e on a fresh `down -v` fixture stack: **279 passed + 4 capture-mail tests ×2
  engines** (transactional has no List-Unsubscribe; subscription has both headers; capture never
  flags delivered; suppression gates subscription only while transactional still records). One
  pre-existing slice4 webkit flake recovered on retry. **Integration fix (coordinator, 1 line):**
  `mail.spec.ts` sweep inlined a JSON-stringified value inside a double-quoted SQL string in the
  `node -e` container seam, so its quotes closed the JS string (`ReferenceError`); reparameterized
  to a bound `?` like the sibling queries.
- **Live pipeline proven end-to-end** (opt-in `e2e:mail`, run once at the gate). The app's own
  live-send test is currently **blocked on the `no-reply@potluckmutualaid.app` credential** —
  DreamHost returns `535 5.7.8 authentication failed` for it (creds reached the container
  byte-identical; STARTTLS negotiates; it's the credential/mailbox itself). Isolated and proven
  it's not code: `testuser1@` authenticates fine, and a full `testuser1→testuser1` self-send
  went SMTP→DreamHost relay→**real delivery**→IMAP-receipt-confirmed. So transport/TLS/send/IMAP
  all work; **Aaron to fix the `no-reply@` mailbox** (correct its password in `.env`, provision it
  as a real mailbox, or auth as a real mailbox while keeping `From: no-reply@`), after which
  `npm run e2e:mail` goes green with zero code change. README "Configure email" documents the
  DNS runbook (verify DreamHost auto SPF/DKIM; add DMARC p=none→ramp; merge-SPF gotcha for the
  eventual Resend switch).
- **Round-C follow-up recorded:** the unsubscribe HMAC falls back to a committed dev secret when
  `MAIL_UNSUB_SECRET` is unset — Round C's `/unsub` route must require a real secret in prod
  (ideally the entrypoint refuses `MAIL_PRODUCTION=1` without it) or tokens are forgeable.

## Phase 2 Round E — the IA flip (2026-07-05) — PHASE 2 COMPLETE

**Done, and with it all five Phase-2 rounds.** The workflow IA shipped: tab bar is
**Neighbors(/) · Plan(/plan) · Home(/home) · More** — every old route (/ledger,
/orders, /items, /recipes, /shares, /shopping) still works, tabs re-parented (deep
links + muscle memory survive). Gate: fresh `down -v` stack, **272 passed + 4
intentional skips, playwright exit 0, both engines** (two known-pattern webkit
flakies, retry-passed).

- **Neighbors (home):** attention strip (activity.list, deep-links only — the
  density-not-actions rule), needs-&-surpluses preview (the Walt rule), then
  per-connected-household sections: @handle → /households/[id], net balance +
  age-of-last-entry → the pair ledger (Settle lives there — the Ledger tab is
  retired into this), lending line, member avatars, and **shared-pantry rows**
  (the cross-household order entry point). SEVERED-with-balance sections persist
  (money stays settleable). Sparse-user honesty verified as nia.
- **Home:** own pantries + Receive FAB (can/hide on receiveStock; shares one
  component with the header quick-action), Items/Recipes/Shopping doors, household
  members/management (moved off More). **Plan:** + outgoing orders + my posts, and
  the in-calendar picker now lists connections' shared books — picking one forks
  then plans (the Priya rule). **More:** curated. `circle.names` (any-member,
  id+name) closes the Round-C gap — member-visibility SELECT no longer needs
  manageConnections.
- **Two regressions the team caught itself before ship:** (1) the flip initially
  left connected pantries unreachable — no UI path to CREATE a cross-household
  order (both the builder and the e2e teammate flagged it independently); fixed
  with the Neighbors shared-pantry rows and browser-verified end-to-end. (2) the
  ledger-new-dot went down with the Ledger tab, orphaning the LedgerSeen
  settlement nudge; restored on the Neighbors tab, same hasNew/markSeen machinery,
  lifecycle browser-verified. Recorded because the CATCH is the process working.
- e2e: suite-wide anchor migration (14 specs; tab clicks → stable routes or the
  new tabs; helpers gained openHome/openNeighbors/gotoStable), new
  `neighbors.spec.ts` (5 tests incl. severed-with-balance and founded-household
  dashboards), slice4's dot assertions retargeted to the Neighbors tab. Docs:
  blueprint 02 Round-E nav amendment, 03 tab comment, SPEC Home-tab reference.
- Follow-up coverage landed: three "Plan surface (P3)" tests pin plan-outgoing-orders,
  plan-my-posts, and the fork-then-plan invariant (the picked shared recipe FORKS into
  the own book — private, attributed — the plan entry references the fork, and author
  edits never propagate to it). 16/16 planner.spec both engines.
- Late correction: the e2e teammate's final pass DID wire the order-flow UI test
  through `neighbors-pantry-row` (plus a netCents post-reload visibility hardening
  that made the two lingering webkit delta-flakes deterministic) — those spec deltas
  landed after the closing gate ran, so they were re-verified separately:
  orders + neighbors + slice4, 47/47 green both engines, zero flakes. Remaining
  follow-up: the pre-existing `/ledger` React #418 hydration warning
  (ledger-view.tsx client-side date formatting) predates the flip.

## Phase 2 Rounds C + D — contact layer & Activity (2026-07-04/05)

**Both done**, built by parallel teams and committed together (one commit: the router
registrations in `index.ts` interleave, so the rounds aren't cleanly bisectable —
recorded tradeoff).

**Round C — contact layer (REWORK §P5).** Additive migration `20260704170000_contact`:
`User.photoPath/phone/bio` (new **avatars** image kind) + `Household.address/
pickupNotes`. Reads: `contacts.household` — **the connection IS the gate** (ACTIVE edge
or own, else 404; no capability, no grant — the share-only edge exposes pickup
logistics by design), members filtered by `reachesMember` (visibility enum is
`ALL|SELECT|PRIVATE` — Round B's spelling, kept); `contacts.requestPreview` for PENDING
incoming shows exactly {name, photoPath, bio} — no phone/email/address pre-accept
(Walt's "see who before I say yes", minimally). `profile.update` self-only;
`household.updateContact` manageHousehold; `membership.setVisibility` self-or-manager.
vCard: `GET /api/vcard/[userId]` and the tRPC read share ONE resolver
(`src/server/contacts.ts`) so the download can never leak a member the card UI
wouldn't; RFC-6350 escaping unit-tested. UI: profile/household-contact/my-visibility
cards on More (edit-in-sheets), the `/households/[id]` contact page (pickup-logistics
FIRST: address → map link → pickup-notes callout → member cards with big photos →
detail sheet with separate large tel:/sms:/mailto: rows + "Save contact" vCard),
request-preview cards in the responder, and READY-order pickup info on the buyer's
order detail. e2e `contacts.spec.ts` 7 tests × 2 engines incl. the UI smoke;
restore-invariant DB-verified post-run.

**Round D — global toolbar + Activity (focus-group consensus).** New `activity.list`
derived read (NO schema, NO mutations): five item types — own restock drafts, incoming
orders (REQUESTED/PICKING actionable for fulfill; owner-side READY informative),
outgoing orders (READY actionable via spend — the pickup gate), pending connection
requests, pending claims on live posts — with `actionableCount` computed per the ACTING
USER's capabilities (the badge is a to-do count, not a read-state). Global sticky
header in layout.tsx: acting-household chip (multi-membership; brand mark otherwise),
Receive quick-action (hidden without receiveStock/pantries — can/hide), bell + badge +
preview popover (top 5, deep-links only) → `/activity` with grouped sections and
inline actions that REUSE existing mutations. **Money is never inlined** — a READY
outgoing order deep-links to the order detail where pickup lives. Duplication rule
held: list rows carry the same action set as origin surfaces or none. Proven live:
theo (Teen) sees the same order in "In motion" with no advance buttons while his
draft stays actionable. e2e `activity.spec.ts` 7 tests × 2 engines + slice7
layout/safe-area regression green.

Known gaps recorded for Round E: member-visibility SELECT requires manageConnections
(circle.list is manager-gated — needs a lighter circle-name read); the can/hide pass
across older surfaces.

**Gate story (a process lesson).** The first integrated gate ran RED (8 failures):
two teammates edited the tree mid-gate (chromium and webkit executed different
versions of the same spec line) and an "isolated" teardown clobbered the main
container mid-run — plus three real-but-shallow spec issues and one genuine find:
`toISOString()` in a spec computes UTC-today while the plan UI's Today is
client-local, so the planner smoke fails every evening west of Greenwich (fixed:
specs compute local ymd). Also fixed: the header's `activity.list` now BATCHES with
`ledger.hasNew` in one tRPC request, so response bodies are arrays ordered by the
URL's procedure list (spec parses the right index); the Round-C profile card put a
second exact-text "Aaron" on /more (slice1 scoped to household cards). Rule
hardened for future rounds: NOTHING edits the tree or touches docker while the
integration gate runs. Re-gate: **264 passed + 4 intentional skips, exit 0, both
engines, zero flakes.**

## Phase 2 Round B — circles (2026-07-04)

**Done** (REWORK Phase-2 §P4). Named per-household **circles replace per-connection
grants entirely** — a circle IS the six-grant bundle; each side of a connection assigns
the other into one of ITS circles (directionality preserved, the counterparty's circle
NAME never leaks — only effective grants); resource scoping rides circles
(pantry/item visibility ALL / SELECT[circles] / PRIVATE replaces the `shared` booleans;
`Membership.visibility` schema hooks land now for Round C). Migration
`20260704150000_circles` REBUILDS Connection/Pantry/Item (pragma-dance exemplar
pattern): per household, seed preset circles (Neighbors: shares only · Friends: per
GRANT_PRESETS incl. recipes — kept as the single source of truth, a deliberate
deviation from the P4 shorthand · Family: all six), then map every connection side's
grant tuple to a preset or a custom circle (dedup via materialized temp tables; all-false
ACTIVE/SEVERED sides get a real "No access" circle; all-false PENDING addressee stays
NULL). Proven by `scripts/verify-circles-migration.mjs` against a synthetic pathological
world (tuple-sharing, preset-name collisions, zero-connection households) — behavior
equivalence per connection side.

- **Authz swap is API-stable**: `grantsFrom` keeps its name and GrantSet shape and now
  resolves the granter's assigned circle; share/ledger/restock/recipe consumers were
  untouched. New reach rule (one helper, unit-tested ×10): ACTIVE edge ∧ circle grants
  the flag ∧ resource visible to that circle. **Grant revocation now reads 404, not
  403** — grants are visibility, not capability (the convention, now uniform).
  Pickup's money re-check stays grant-based (matching prior behavior).
- Routers: new `circle` CRUD (delete 409s while referenced); connection request/respond
  take `circleId`; `connection.assign` replaces `setGrants`; `pantry.setVisibility` /
  `item.setVisibility` replace the shared flags. Invites still carry a raw grant bundle
  (no circle exists on the unfounded side; the server maps both sides at acceptance —
  the one deliberate raw-grants exception, in the household-invite mint UI).
- UI: Circles card (create/edit/delete with plain-language grant labels — shared
  GRANT_LABELS, the Walt rule), circle pickers on request/respond, per-connection
  "In: {circle}" + Move, three-way visibility controls with circle multi-select on
  pantry + item surfaces.
- e2e: new `circles.spec.ts` (8 tests: seeded equivalence, CRUD+gates,
  move-flips-reach-live both directions, edit-circle-grants-flips-live, SELECT needs
  grant AND scope, invite first-edge presets, PENDING semantics, UI smoke);
  `connections.spec.ts` reworked onto circles with B6 fallout intact; onboarding's
  casa-sweep gained the circle-table FK deletes. Restore-invariant discipline: seeded
  topology verified byte-identical after runs.
- **Gate: fresh `down -v` stack (migration + new seed), 236 passed + 4 intentional
  skips, playwright exit 0, both engines, zero flakes — this run is also Round A's
  deferred full-suite proof.**
- Deferred/noted: `circle.list` is manageConnections-gated (Round C may need a lighter
  name-only read); an SSR-first-request-on-fresh-session intermittent 404 was seen and
  routed around in specs (household.overview probes) — worth a look someday.

## Phase 2 Round A — receiving tweaks (2026-07-04)

**Done** (Aaron's list, REWORK Phase-2 §P7). The wizard ✕ now CLOSES and keeps the
draft (aria "Close (draft is saved)"; the resume banner re-surfaces it); abandoning is
an explicit text-danger "Abandon restock…" button on every draft step (confirm +
deleteDraft unchanged). The Process sheet is now the one line-dispositioning surface:
it shows the restock's lot code in its header (the modal covers the screen behind it —
the user labels jars from the sheet), gains inline unit-photo capture (same
downscale/'units' pipeline; `saveLine` takes an optional fresh-upload-validated
`unitPhotoPath` applied to the lot in the same transaction; step-4 and the lot ⋯ menu
keep `setUnitPhoto`), and the **one-tap Confirm on matched proposals is gone** — every
line is Processed or Ignored, working the haul line by line.

Gate note (deviation, recorded honestly): built and verified in an ISOLATED WORKTREE
at HEAD + these four files because the shared working tree held the circles round's
in-progress non-compiling refactor — receiving-scope e2e (slice2/slice5/tweaks/orders)
green on BOTH engines from a fresh stack (61 passed / 3 expected skips, exit 0) plus a
hand-driven browser demo (screenshots `.playwright-mcp/round-a/`). The full-suite
proof rides the Round-B integration gate. e2e updates: slice5's landProposal always
goes through Process; "no proposal ever offers one-tap Confirm"; new sheet-photo test;
slice2's abandon flow moved to the explicit button + a ✕-persists-then-resume check.


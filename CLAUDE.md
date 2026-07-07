# CLAUDE.md

Potluck (formerly "Private Coop"): a self-hosted web app (PWA) for mutual aid between households — nodes in a network of pairwise connections sharing pantry goods and equipment at cost, with a netted per-household-pair ledger.

## Current state (2026-07-07)

**Rounds Q–T + follow-ups (2026-07-06) — device feedback, recipes UX, nav model.**
**Round Q** — six real-device fixes plus the app's back-navigation primitive:
`src/app/nav-history.tsx`, a sessionStorage nav stack (NavTracker in the layout) +
`BackLink({fallback})`. Back arrows navigate the recorded stack explicitly (an A→B→A
return collapses as POP); **never use `router.back()`** — the nav stack is the single
source of truth for in-app back intent. **Round R** — a unified recipe read view at
`/recipes/[id]` (+ `/edit`; own recipes no longer drop straight into the edit form), the
step-by-step **Cook view** (`/recipes/[id]/cook`: swipe/keyboard, servings scaling,
wake-lock), and `recipe.importUrl` now downloads the recipe photo server-side
(SSRF-guarded). **Round S** — "Add from Plan" + per-entry `shopping.addFromEntry` over
the extracted shared core `src/server/shopping-generate.ts`; idempotent re-adds (the
PTE never-silently-remove invariant); migration `20260706120000_plan_shopping_tracking`
(`PlanEntry.addedToShoppingAt`). **Round T** — `min-h-dvh` tab-bar fix (short iOS Safari
pages), household invites pick a **Circle** (grants snapshotted at mint — closes the
per-invite-presets deferral), "Save contact to device" vCard copy. Post-Phase-3 also
landed: digest cadence (per-user off/daily/weekly, **daily default**) + the in-process
scheduler (`src/instrumentation.ts`), and profile polish (avatar scale-and-crop, US
phone formatting, TZ auto-detect).

**Phase 3 (email · notifications · auth flows · deep-linking) is COMPLETE — four
rounds, 2026-07-05.** Commits 4fe63d9 (A), d216f25 (B), c7868fe (C), + D.
**Round A** — a swappable nodemailer transport (DreamHost; `MAIL_MODE=capture` default)
behind two pipelines (`sendTransactional` never carries unsubscribe / ignores prefs;
`sendSubscription` = RFC-8058 one-click) + a fail-closed dev mail-capture filter +
`CapturedEmail` audit table. **Round B** — email verification + password reset
(enumeration-safe, no-TOTP-bypass, session-revoking) + MFA (TOTP with an AES-256-GCM
secret + backup codes; rate-limited emailed codes; login returns a discriminated
`mfaRequired` union) + admin-required TOTP + durable fixture TOTP (`scripts/dump-demo-creds`
→ 1Password otpauth). **Round C** — a per-user notification preference matrix (categories
pickups/circle/ledger × push+email + weekly-digest opt-out + show-details toggle), a
generalized `notify()` layer wired into 5 events with the N4 category-only content rule
(own-household stamp, never a counterparty name/$/address), a weekly digest, and the
RFC-8058 `/unsub` route (+ `MAIL_UNSUB_SECRET` prod guard). **Round D** — navigation-only
HMAC deep-link tokens + the `/go` route (a notification tap lands on the actionable screen
AND switches the acting household; email links route-then-login-to-act, never authenticate)
+ login `next=` continuation. All capture-mode-gated on both engines; the live DreamHost
send is proven (delivered), IMAP receipt-verify awaits an auth-throttle cooldown. Decision
record: REWORK.md "Phase 3" (N1–N11); per-round records in PLAN.md. Migrations
`20260705100000_mail`, `20260705140000_auth`, `20260705180000_notifications` (Round D adds
none — stateless token). Deferred cosmetic follow-up: unify the MFA router's per-factor
aliases. Money invariants + append-only ledger untouched throughout.

**v1 shipped, the four-round mutual-aid rework is COMPLETE, and Phase 2 (workflow
IA + circles + contact layer) is COMPLETE — five more rounds, 2026-07-04/05.** The
app now runs the workflow IA: tabs **Neighbors(/) · Plan · Home · More** (old routes
/ledger /orders /items all still work — re-parented, not removed), a global header
(acting-household chip · Receive quick-action · bell → /activity with
capability-gated inline actions), **circles** as the entire permissions model (named
per-household grant bundles replace per-connection grants; pantry/item/member
visibility = ALL/SELECT[circles]/PRIVATE; `grantsFrom` resolves circles behind the
unchanged authz API; grant loss reads 404), and the **contact layer** (profiles with
photo/phone/bio, household address + pickup notes, /households/[id] member cards
with tel:/sms:/vCard — connection IS the gate). Phase-2 decision record: REWORK.md
"Phase 2" section (focus-group synthesis + P1–P7); per-round records in PLAN.md.

**v1 + rework state (still true underneath):**
Round 1 (network core, five slices) shipped in an overnight autonomous session
(2026-07-03→04); Rounds 2–4 shipped 2026-07-04 as coordinated teammate rounds (a
server / UI / e2e teammate per round, coordinator-integrated): **Round 2** needs &
surpluses (SharePost/ShareClaim, $0 gift takes, anonymized hop-limited reshares),
**Round 3** recipes (browse-live/fork-on-save over the `recipes` grant, learned
IngredientLink map, paste-to-parse + SSRF-guarded URL import), **Round 4** planner +
shopping (PlanEntry week planner, a persistent never-silently-removed ShoppingItem list
with PTE-conservative merging, learned categories, cross-pantry availability badges
feeding the existing order flow). Every round committed green on both engines against
the real container; all migrations additive. See PLAN.md (newest first) for per-round
records and docs/REWORK.md for the decision log.

What the rework changed structurally (read PLAN.md + docs/REWORK.md before touching):
- **Membership replaces `User.householdId`** — a user belongs to N households, each with
  11 capability flags (`src/server/capabilities.ts`); `getSessionUser()` resolves the
  sticky **acting household** (`potluck_household` cookie) behind the legacy `householdId`
  shape, so every consumer still reads `ctx.user.householdId` (now = acting household).
- **`Connection`** (pairwise, PENDING/ACTIVE/SEVERED; each side assigns the other into
  one of its own **circles**, whose six flags are the directional grants) is the
  visibility+reach primitive; **`src/server/authz.ts`** is the choke point
  (`requireCapability`, `hasActiveGrant`, `activeConnectionsOf`, `loadAccessiblePantry`).
  Error convention: missing capability = 403, missing visibility = 404 (never leak
  existence). Money reach is re-checked at the money moment (pickup/finalize).
- **Per-household `Product`**, `Take.householdId` / `Loan.borrowerHouseholdId`
  attribution snapshots, instance-settings + `isInstanceAdmin`. (The old
  `Pantry.shared`/`Item.shared` booleans became circle-scoped `visibility` in Phase 2.)
- Identity is username-or-email; demo seed grew to **three households** (Heise, In-Laws,
  Neighbors) with Teen/multi-membership fixtures — see `prisma/seed.ts`.

Rounds 2–4 added (all connection-scoped, all rider on the same authz choke point):
`SharePost`/`SharePostLot`/`ShareClaim` + `Take.shareClaimId` (a take with it set is a
**$0 gift** — no ledger entry, the one sanctioned cross-household no-money take;
blueprint-01 invariant 4 records it), `Recipe`/`RecipeIngredient`/`IngredientLink`,
`PlanEntry`/`ShoppingItem`/`CategoryAssignment`. New image kinds `shares`/`recipes`.
Routers `share`/`recipe`/`plan`/`shopping`. (Their pages originally rode home-tab
strips; Phase 2's IA flip re-homed them under Neighbors/Plan/Home.)

Migrations: `20260703100000_network_core` (the big data-preserving one),
`20260703120000_household_invites`, `20260704090000_shares`,
`20260704110000_recipes`, `20260704130000_planner`, `20260704150000_circles`
(rebuilds Connection/Pantry/Item; proven by scripts/verify-circles-migration.mjs),
`20260704170000_contact`. **Every money invariant and the
append-only ledger survived untouched** — shares/recipes/planner add zero money paths
(gifts post $0 takes, shopping's add-to-order calls the existing `order.addToCart`).

Do not start large autonomous workflows without an explicit ask. The **canonical
deferred list** lives in docs/REWORK.md (blockquote after the Round plan: minors + the
waiting-on-an-adult handoff state; staples/stores/menus/queue; federation build-out;
connection-scoped image serving; the /ledger React #418 hydration warning; …); the
near-term items are hoisted to "Outstanding work" at the top of PLAN.md — resume from
there. (Notifications and per-invite grant presets used to be on this list; both have
shipped.)

**SPEC.md, the blueprints, and README were re-synced to the running app 2026-07-07**
(post-Rounds Q–T; SPEC was first rewritten at Round 1/R1S5). Rebrand notes: cookies are `potluck_session`/`potluck_household`
and the manifest is "Potluck", but `/data/coop.db`, the `coop-data` volume, and the repo
directory deliberately keep their names (renaming would orphan existing deployments'
data; repo rename is Aaron's call). Demo seed emails stay `@demo.coop` (fixtures, keyed
by upsert). The jar brand mark stayed — a new mark can ride the domain hunt.

## Read first

- **[SPEC.md](./SPEC.md)** — the scope contract: domain model, flows, money invariants, out-of-scope guardrails. Deliberately small; keep it that way.
- **[PLAN.md](./PLAN.md)** — newest-first per-round build records, with the outstanding-work list at the top. Append dated notes for any change. Pre-Phase-2 history (v1 slices, rework Rounds 1–4) is archived in [docs/plan-archive.md](./docs/plan-archive.md).
- **[README.md](./README.md)** — how to run it, and the "Go live" deploy runbook (bootstrap the first household, TLS reverse proxy, secrets).
- **[docs/blueprint/](./docs/blueprint/)** — 00 overview, 01 data model + money invariants, 02 UX flows, 03 design system, 04 infra. Authoritative for money/lifecycle questions.

## Run it

```bash
SEED_DEMO=1 EXTRACTION_MODE=fixture docker compose up -d --wait   # then localhost:3000
npm run e2e                                                        # full suite, both engines
```

Demo logins (seeded only): usernames `aaron` / `marie` / `dana` / `nia` / `theo` (or
their `@demo.coop` emails), password `demo-password`. Marie is the multi-membership
switcher fixture; Theo is Teen-preset; Neighbors is share-only-connected to Heise and
unconnected to In-Laws.

## Working rules (still in force)

1. **Nothing is done until it demonstrably works** in a real browser against the real compose stack, with Playwright e2e passing on both engines (chromium-light + webkit-dark). Unit-test coverage is not a goal and never a substitute for a browser demo.
2. **Money is integer cents.** Every multi-write money operation goes through `dbTransaction` (the app-level lock in `src/server/db.ts` — never call `db.$transaction` directly), and every money-writing mutation carries a `clientKey` for idempotency. The ledger is append-only; corrections are swapped-party REVERSAL entries, never edits.
3. **Colors are semantic tokens only** — the default Tailwind palette is deleted, so `bg-white`/`text-stone-*` etc. silently fail. `npm run lint:tokens` enforces this. Dark mode is a token swap via `prefers-color-scheme` (no `dark:` variants). Verify new UI in both schemes.
4. TypeScript end to end, types generated from one Prisma schema. Use `docker compose` (space-separated), never `docker-compose`. Port 3000 is exclusive.
5. Prisma 7 gotchas: datasource url lives in `prisma.config.ts` (not the schema); driver adapter required; `prisma generate` is manual after schema changes; migrations are hand-timestamped to preserve order.

## History warning

Branches `archive/2025-main` and `archive/2025-take2` hold the abandoned 2025 attempts: ~155 files of overengineered AI-generated design docs and an implementation whose "Phase 1 Complete" status was never real (frontend unwired, integration tests fully mocked). Reference them only deliberately — do not import their docs, patterns, or tests. The one trustworthy ancestral document is `local_only/design_discussions/RAW_REQUIREMENTS.md` (on the archive branches); SPEC.md already distills it.

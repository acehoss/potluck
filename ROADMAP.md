# Potluck roadmap

This is the only active backlog for the production app. Keep it short and limited to
work that has not shipped. When something ships, remove it; release history belongs in
Git and the frozen build logs under [`docs/archive/`](./docs/archive/).

Current behavior and invariants live in [`SPEC.md`](./SPEC.md). Durable architectural or
product choices belong in [`docs/decisions/`](./docs/decisions/), not in this file.

## Now — production hygiene

- Authorize media reads through the same connection/circle visibility rules as their
  owning resources; raw file paths must not become a side door around access control.
- Fix the headerless receive wizard's top safe-area inset on notched devices.
- Verify the production secret posture: a non-demo Anthropic key where live extraction
  is enabled, a real VAPID keypair, and no committed/demo secrets in use.
- Complete real-device checks on iPhone and Android: installed PWA, closed-app push with
  the correct deep link, push-enable timeout recovery, and a real UPC-A scan (including
  the Android torch control).

## Next — user-facing evolution

- Add a household transfer-history surface using the existing
  `transfer.listForHousehold` query.
- Add reconcile's third shortage resolution: fill an affected order from another
  placement of the same product.
- Let low-permission members flag an inventory count as suspicious for an
  `adjustInventory` member to handle.
- Decide whether recipes need circle-selective visibility; they currently have only a
  private/shared boundary.

## Reliability and verification

- Run the opt-in IMAP receipt check for a real DreamHost send after the authentication
  throttle permits it.
- Consider a participant-only push nudge for stale reconcile sessions; the banner and
  lazy 24-hour abandon already provide the safety boundary.
- Consider per-row "being counted" badges. Mutation-time `412` messages are the current
  contextual surface.

## Technical debt and polish

- Remove the `/ledger` React hydration warning.
- Unify the MFA router's per-factor aliases.
- Replace the Prisma 7 delegate casts in authz/circles/contacts/share-reach when driver
  typing makes the delegate unions callable again.
- Clean up remaining ragged wraps at 390 px.

## Later

- Federation build-out from the recorded protocol direction.
- Minors and waiting-on-an-adult handoff states.
- Staples, stores, menus, and cooking queue.
- Label printing, SKU merging, low-stock nudges, chore tracking, and shared write-off
  offers.

## Explicitly parked or accepted

- Legacy adjustment `clientKey` replay across the stock-placement deploy boundary is an
  accepted compatibility risk.
- `reconcile.get` may cosmetically expose an expired `DRAFT` until a freeze check or new
  session lazily abandons it; stock mutation remains protected.

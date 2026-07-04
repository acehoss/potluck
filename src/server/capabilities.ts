/**
 * Membership capability vocabulary (REWORK A3a). Flags live as booleans on
 * Membership; every authz check in code is a typed capability test. Named
 * roles are UI PRESETS over the flags — starting points, individually tunable
 * per membership — never a schema concept. `placeOrders` is REWORK's `order`
 * flag renamed (SQL keyword / Order-model collision).
 */

export const CAPABILITIES = [
  'manageHousehold',
  'manageConnections',
  'receiveStock',
  'placeOrders',
  'spend',
  'fulfill',
  'adjustInventory',
  'lendBorrow',
  'postShares',
  'editRecipes',
  'settleMoney',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityFlags = Record<Capability, boolean>;

function preset(granted: readonly Capability[]): CapabilityFlags {
  return Object.fromEntries(
    CAPABILITIES.map((c) => [c, granted.includes(c)]),
  ) as CapabilityFlags;
}

/** Owner — everything, including household management. */
export const OWNER_PRESET: CapabilityFlags = preset(CAPABILITIES);

/** Adult — everything except managing the household itself. */
export const ADULT_PRESET: CapabilityFlags = preset(
  CAPABILITIES.filter((c) => c !== 'manageHousehold'),
);

/** Teen — day-to-day participation, no money-moving or management. */
export const TEEN_PRESET: CapabilityFlags = preset([
  'receiveStock',
  'placeOrders',
  'lendBorrow',
  'postShares',
  'editRecipes',
]);

/** Child — view-mostly (recipes/planner writes only). */
export const CHILD_PRESET: CapabilityFlags = preset(['editRecipes']);

export const ROLE_PRESETS = {
  owner: OWNER_PRESET,
  adult: ADULT_PRESET,
  teen: TEEN_PRESET,
  child: CHILD_PRESET,
} as const;

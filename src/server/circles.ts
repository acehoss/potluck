import type { Prisma } from '@/generated/prisma/client';
import { GRANT_PRESETS, GRANTS, type GrantSet } from './authz';
import type { db } from './db';

/**
 * Circles (REWORK Phase-2 P4): a household's named grant bundles. A circle IS
 * the six directional grants that used to live per-connection; each side of a
 * connection assigns the other household into one of ITS OWN circles.
 *
 * The three PRESET circles seeded for every household mirror the GRANT_PRESETS
 * "levels" (authz.ts is the single source of truth for the tuples):
 *   Neighbors — shares only (shareTo/shareFrom)
 *   Friends   — + pantry, lending, recipes
 *   Family    — everything, including onward resharing
 * The data-preserving migration and the invite/bootstrap paths reuse these so a
 * pre-circles grant tuple that matches a level maps back to the same name.
 */

type Dbc = Prisma.TransactionClient | typeof db;

function prisma(dbc: Dbc): Prisma.TransactionClient {
  return dbc as unknown as Prisma.TransactionClient;
}

/** The six circle grant columns as a plain object. */
export type CircleGrantColumns = {
  grantsPantry: boolean;
  grantsLending: boolean;
  grantsRecipes: boolean;
  grantsShareTo: boolean;
  grantsShareFrom: boolean;
  grantsReshare: boolean;
};

/** GrantSet → circle columns (grantsPantry…), the storage shape. */
export function grantColumnsOf(grants: GrantSet): CircleGrantColumns {
  return {
    grantsPantry: grants.pantry,
    grantsLending: grants.lending,
    grantsRecipes: grants.recipes,
    grantsShareTo: grants.shareTo,
    grantsShareFrom: grants.shareFrom,
    grantsReshare: grants.reshare,
  };
}

/** The three preset circles, in display order (position 0..2). */
export const PRESET_CIRCLES = [
  { name: 'Neighbors', grants: GRANT_PRESETS.neighbor },
  { name: 'Friends', grants: GRANT_PRESETS.friend },
  { name: 'Family', grants: GRANT_PRESETS.family },
] as const;

/** Prisma create-data for a household's three preset circles. */
export function presetCircleData(householdId: string) {
  return PRESET_CIRCLES.map((preset, position) => ({
    householdId,
    name: preset.name,
    position,
    ...grantColumnsOf(preset.grants),
  }));
}

/** Seed the three preset circles for a household (idempotent per name). */
export async function ensurePresetCircles(dbc: Dbc, householdId: string) {
  const client = prisma(dbc);
  for (const data of presetCircleData(householdId)) {
    await client.circle.upsert({
      where: { householdId_name: { householdId, name: data.name } },
      update: {},
      create: data,
    });
  }
}

/** The preset circle NAME whose bundle equals `grants`, else null. */
export function presetNameForGrants(grants: GrantSet): string | null {
  for (const preset of PRESET_CIRCLES) {
    if (GRANTS.every((g) => preset.grants[g] === grants[g])) return preset.name;
  }
  return null;
}

/**
 * Resolve the circle a household should assign the counterparty into for a
 * given grant tuple (invite / seed paths). A tuple matching a preset reuses
 * that preset circle; anything else mints (or reuses) a custom circle named
 * after the counterparty household. All-false never matches a preset — it
 * produces a "No access" custom circle so an ACTIVE edge keeps both sides
 * non-null (mirrors the migration's rule).
 */
export async function circleIdForGrants(
  dbc: Dbc,
  ownerHouseholdId: string,
  grants: GrantSet,
  counterpartyName: string,
): Promise<string> {
  const presetName = presetNameForGrants(grants);
  const client = prisma(dbc);
  if (presetName) {
    const circle = await client.circle.findUnique({
      where: { householdId_name: { householdId: ownerHouseholdId, name: presetName } },
    });
    if (circle) return circle.id;
  }
  const allFalse = GRANTS.every((g) => !grants[g]);
  const baseName = allFalse ? 'No access' : counterpartyName;
  // A custom circle carries this exact tuple; reuse one if the household already
  // has a same-named circle with the same bundle, else find a free name.
  const columns = grantColumnsOf(grants);
  for (let attempt = 0; ; attempt++) {
    const name = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
    const existing = await client.circle.findUnique({
      where: { householdId_name: { householdId: ownerHouseholdId, name } },
    });
    if (!existing) {
      const created = await client.circle.create({
        data: { householdId: ownerHouseholdId, name, position: 99, ...columns },
      });
      return created.id;
    }
    const matches =
      existing.grantsPantry === columns.grantsPantry &&
      existing.grantsLending === columns.grantsLending &&
      existing.grantsRecipes === columns.grantsRecipes &&
      existing.grantsShareTo === columns.grantsShareTo &&
      existing.grantsShareFrom === columns.grantsShareFrom &&
      existing.grantsReshare === columns.grantsReshare;
    if (matches) return existing.id;
  }
}

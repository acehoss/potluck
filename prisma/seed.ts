/**
 * Demo/e2e fixtures for the Potluck network (REWORK D3). Three households:
 *
 *  - Heise — Aaron (instance admin, Owner), Marie (Owner; also an Adult
 *    member of Neighbors — the multi-membership user that exercises the
 *    acting-household switcher), Theo (Teen preset — exercises capability
 *    denials: no spend/settleMoney/fulfill/adjustInventory/manageHousehold).
 *  - In-Laws — Dana (Owner).
 *  - Neighbors — Nia (Owner).
 *
 * Connections: Heise↔In-Laws ACTIVE with FULL mutual grants (the original
 * two-family coop); Heise↔Neighbors ACTIVE with SHARE-ONLY grants (no
 * pantry/lending — the visible-but-not-browsable edge); In-Laws↔Neighbors
 * NOT connected (the unconnected negative). Every user gets a Membership;
 * the instance-settings row exists. Idempotent — safe to run repeatedly.
 * Not for production data.
 */
import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { hashSync } from '@node-rs/argon2';
import {
  ADULT_PRESET,
  OWNER_PRESET,
  TEEN_PRESET,
  type CapabilityFlags,
} from '../src/server/capabilities';
import { PrismaClient } from '../src/generated/prisma/client';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password';

const FIXTURES = [
  {
    household: 'Heise',
    slug: 'heise',
    pantry: 'Basement Pantry',
    users: [
      { name: 'Aaron', username: 'aaron', email: 'aaron@demo.coop', isInstanceAdmin: true },
      { name: 'Marie', username: 'marie', email: 'marie@demo.coop', isInstanceAdmin: false },
      {
        name: 'Theo',
        username: 'theo',
        email: 'theo@demo.coop',
        isInstanceAdmin: false,
        preset: TEEN_PRESET,
      },
    ],
  },
  {
    household: 'In-Laws',
    slug: 'in-laws',
    pantry: 'Basement Pantry',
    users: [{ name: 'Dana', username: 'dana', email: 'dana@demo.coop', isInstanceAdmin: false }],
  },
  {
    household: 'Neighbors',
    slug: 'neighbors',
    pantry: 'Garage Shelves',
    users: [{ name: 'Nia', username: 'nia', email: 'nia@demo.coop', isInstanceAdmin: false }],
  },
] satisfies Array<{
  household: string;
  slug: string;
  pantry: string;
  users: Array<{
    name: string;
    username: string;
    email: string;
    isInstanceAdmin: boolean;
    preset?: CapabilityFlags;
  }>;
}>;

const FULL_GRANTS = {
  aGrantsPantry: true,
  aGrantsLending: true,
  aGrantsRecipes: true,
  aGrantsShareTo: true,
  aGrantsShareFrom: true,
  aGrantsReshare: true,
  bGrantsPantry: true,
  bGrantsLending: true,
  bGrantsRecipes: true,
  bGrantsShareTo: true,
  bGrantsShareFrom: true,
  bGrantsReshare: true,
};

const SHARE_ONLY_GRANTS = {
  ...Object.fromEntries(Object.keys(FULL_GRANTS).map((k) => [k, false])),
  aGrantsShareTo: true,
  aGrantsShareFrom: true,
  bGrantsShareTo: true,
  bGrantsShareFrom: true,
} as typeof FULL_GRANTS;

async function connect(
  householdId1: string,
  householdId2: string,
  grants: typeof FULL_GRANTS,
) {
  const [householdAId, householdBId] = [householdId1, householdId2].sort();
  await db.connection.upsert({
    where: { householdAId_householdBId: { householdAId, householdBId } },
    update: {},
    create: {
      householdAId,
      householdBId,
      status: 'ACTIVE',
      activatedAt: new Date(),
      ...grants,
    },
  });
}

async function main() {
  const passwordHash = hashSync(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  await db.instanceSettings.upsert({
    where: { id: 'instance' },
    update: {},
    create: { id: 'instance' },
  });

  const householdByName = new Map<string, string>();
  const userByUsername = new Map<string, string>();
  for (const fixture of FIXTURES) {
    let household = await db.household.findFirst({ where: { name: fixture.household } });
    household ??= await db.household.create({
      data: { name: fixture.household, slug: fixture.slug },
    });
    householdByName.set(fixture.household, household.id);

    for (const user of fixture.users) {
      const created = await db.user.upsert({
        where: { email: user.email },
        update: {},
        create: {
          name: user.name,
          username: user.username,
          email: user.email,
          passwordHash,
          isInstanceAdmin: user.isInstanceAdmin,
        },
      });
      userByUsername.set(user.username, created.id);
      await db.membership.upsert({
        where: { userId_householdId: { userId: created.id, householdId: household.id } },
        update: {},
        create: {
          userId: created.id,
          householdId: household.id,
          ...(user.preset ?? OWNER_PRESET),
        },
      });
    }

    const pantry = await db.pantry.findFirst({
      where: { householdId: household.id, name: fixture.pantry },
    });
    if (!pantry) {
      await db.pantry.create({ data: { name: fixture.pantry, householdId: household.id } });
    }
  }

  // Marie's second membership (Adult in Neighbors): the switcher fixture.
  // Created AFTER her Heise membership so her default acting household stays
  // Heise (memberships order by createdAt, id).
  await db.membership.upsert({
    where: {
      userId_householdId: {
        userId: userByUsername.get('marie')!,
        householdId: householdByName.get('Neighbors')!,
      },
    },
    update: {},
    create: {
      userId: userByUsername.get('marie')!,
      householdId: householdByName.get('Neighbors')!,
      ...ADULT_PRESET,
    },
  });

  await connect(householdByName.get('Heise')!, householdByName.get('In-Laws')!, FULL_GRANTS);
  await connect(householdByName.get('Heise')!, householdByName.get('Neighbors')!, SHARE_ONLY_GRANTS);
  // In-Laws ↔ Neighbors deliberately NOT connected.

  console.log(`Seeded ${FIXTURES.length} demo households (password: ${PASSWORD})`);
}

main().finally(() => db.$disconnect());

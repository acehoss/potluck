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
import { ensurePresetCircles } from '../src/server/circles';
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

/** The circle id owned by `householdId` with `name` (presets are seeded first). */
async function circleId(householdId: string, name: string): Promise<string> {
  const circle = await db.circle.findUniqueOrThrow({
    where: { householdId_name: { householdId, name } },
  });
  return circle.id;
}

/**
 * An ACTIVE edge where each side places the other into one of its OWN preset
 * circles (P4). `circleForA`/`circleForB` name the circle household 1 / 2 use.
 */
async function connect(
  householdId1: string,
  circleName1: string,
  householdId2: string,
  circleName2: string,
) {
  const [householdAId, householdBId] = [householdId1, householdId2].sort();
  const oneIsA = householdAId === householdId1;
  const aCircleId = await circleId(householdAId, oneIsA ? circleName1 : circleName2);
  const bCircleId = await circleId(householdBId, oneIsA ? circleName2 : circleName1);
  await db.connection.upsert({
    where: { householdAId_householdBId: { householdAId, householdBId } },
    update: { aCircleId, bCircleId },
    create: {
      householdAId,
      householdBId,
      status: 'ACTIVE',
      activatedAt: new Date(),
      aCircleId,
      bCircleId,
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

    // Every household starts with the three preset circles (REWORK P4).
    await ensurePresetCircles(db, household.id);
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

  // Heise↔In-Laws: each places the other in Family (full mutual grants).
  // Heise↔Neighbors: each places the other in Neighbors (share-only). These are
  // the load-bearing topology the e2e suite asserts against.
  await connect(
    householdByName.get('Heise')!,
    'Family',
    householdByName.get('In-Laws')!,
    'Family',
  );
  await connect(
    householdByName.get('Heise')!,
    'Neighbors',
    householdByName.get('Neighbors')!,
    'Neighbors',
  );
  // In-Laws ↔ Neighbors deliberately NOT connected.

  console.log(`Seeded ${FIXTURES.length} demo households (password: ${PASSWORD})`);
}

main().finally(() => db.$disconnect());

/**
 * Demo/e2e fixtures: two households with one pantry each — Heise with two
 * members (the second exercises "the recorder's housemates still see new
 * ledger entries"), In-Laws with one. Network core (Potluck Round 1): every
 * member gets a full-capability (Owner) Membership, the two households are
 * connected with an ACTIVE full-grant edge, the instance-settings row exists,
 * and Aaron is the instance admin. Idempotent — safe to run repeatedly.
 * Not for production data.
 */
import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { hashSync } from '@node-rs/argon2';
import { OWNER_PRESET } from '../src/server/capabilities';
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
    ],
  },
  {
    household: 'In-Laws',
    slug: 'in-laws',
    pantry: 'Basement Pantry',
    users: [{ name: 'Dana', username: 'dana', email: 'dana@demo.coop', isInstanceAdmin: false }],
  },
];

async function main() {
  const passwordHash = hashSync(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  await db.instanceSettings.upsert({
    where: { id: 'instance' },
    update: {},
    create: { id: 'instance' },
  });

  const householdIds: string[] = [];
  for (const fixture of FIXTURES) {
    let household = await db.household.findFirst({ where: { name: fixture.household } });
    household ??= await db.household.create({
      data: { name: fixture.household, slug: fixture.slug },
    });
    householdIds.push(household.id);

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
      await db.membership.upsert({
        where: { userId_householdId: { userId: created.id, householdId: household.id } },
        update: {},
        create: { userId: created.id, householdId: household.id, ...OWNER_PRESET },
      });
    }

    const pantry = await db.pantry.findFirst({
      where: { householdId: household.id, name: fixture.pantry },
    });
    if (!pantry) {
      await db.pantry.create({ data: { name: fixture.pantry, householdId: household.id } });
    }
  }

  // ACTIVE full-grant connection between the two demo households (canonical
  // order: householdAId < householdBId), mirroring the data migration's
  // behavior-preserving edge.
  const [a, b] = [...householdIds].sort();
  await db.connection.upsert({
    where: { householdAId_householdBId: { householdAId: a, householdBId: b } },
    update: {},
    create: {
      householdAId: a,
      householdBId: b,
      status: 'ACTIVE',
      activatedAt: new Date(),
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
    },
  });

  console.log(`Seeded ${FIXTURES.length} demo households (password: ${PASSWORD})`);
}

main().finally(() => db.$disconnect());

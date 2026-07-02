/**
 * Demo/e2e fixtures: two households with one pantry each — Heise with two
 * members (the second exercises "the recorder's housemates still see new
 * ledger entries"), In-Laws with one. Idempotent — safe to run repeatedly.
 * Not for production data.
 */
import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { hashSync } from '@node-rs/argon2';
import { PrismaClient } from '../src/generated/prisma/client';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password';

const FIXTURES = [
  {
    household: 'Heise',
    pantry: 'Basement Pantry',
    users: [
      { name: 'Aaron', email: 'aaron@demo.coop' },
      { name: 'Marie', email: 'marie@demo.coop' },
    ],
  },
  {
    household: 'In-Laws',
    pantry: 'Basement Pantry',
    users: [{ name: 'Dana', email: 'dana@demo.coop' }],
  },
];

async function main() {
  const passwordHash = hashSync(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  for (const fixture of FIXTURES) {
    let household = await db.household.findFirst({ where: { name: fixture.household } });
    household ??= await db.household.create({ data: { name: fixture.household } });

    for (const user of fixture.users) {
      await db.user.upsert({
        where: { email: user.email },
        update: {},
        create: { ...user, passwordHash, householdId: household.id },
      });
    }

    const pantry = await db.pantry.findFirst({
      where: { householdId: household.id, name: fixture.pantry },
    });
    if (!pantry) {
      await db.pantry.create({ data: { name: fixture.pantry, householdId: household.id } });
    }
  }

  console.log(`Seeded ${FIXTURES.length} demo households (password: ${PASSWORD})`);
}

main().finally(() => db.$disconnect());

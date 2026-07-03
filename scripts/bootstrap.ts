/**
 * Bootstrap the FIRST real household + user of a fresh (non-demo) deployment.
 *
 * Registration is invite-only by design (SPEC §4): every other account is
 * minted from an invite created by an already-logged-in member. That is a
 * chicken-and-egg for the very first user — this script is the sanctioned way
 * out. It creates a household, its first pantry, and an owner user with a real
 * argon2id password hash (same params as the app). Everyone else then joins by
 * invite from inside the app.
 *
 * Run it against the live container, e.g.:
 *   docker compose exec app npx tsx scripts/bootstrap.ts \
 *     "Heise" "Aaron" "aaron@example.com" "a-strong-password" "Basement Pantry"
 *
 * Idempotent on the household NAME (reuses an existing one so a second
 * household's first member can be added the same way); refuses to clobber an
 * existing email. Not tied to SEED_DEMO and creates no demo identifiers.
 */
import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { hashSync } from '@node-rs/argon2';
import { PrismaClient } from '../src/generated/prisma/client';

const [householdName, userName, email, password, pantryName = 'Pantry'] = process.argv.slice(2);

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error(
    'usage: npx tsx scripts/bootstrap.ts <household> <userName> <email> <password> [pantryName]',
  );
  process.exit(1);
}

if (!householdName?.trim()) fail('household name is required');
if (!userName?.trim()) fail('user name is required');
if (!email?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('a valid email is required');
if (!password || password.length < 10) fail('password must be at least 10 characters');

const url = process.env.DATABASE_URL;
if (!url) fail('DATABASE_URL is not set');
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: url! }) });

async function main() {
  const normalizedEmail = email.trim().toLowerCase();
  if (await db.user.findUnique({ where: { email: normalizedEmail } })) {
    fail(`a user with email ${normalizedEmail} already exists`);
  }

  // Same argon2id parameters as src/server/auth.ts (OWASP).
  const passwordHash = hashSync(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  let household = await db.household.findFirst({ where: { name: householdName.trim() } });
  household ??= await db.household.create({ data: { name: householdName.trim() } });

  const user = await db.user.create({
    data: {
      name: userName.trim(),
      email: normalizedEmail,
      passwordHash,
      householdId: household.id,
    },
  });

  const pantry = await db.pantry.findFirst({
    where: { householdId: household.id, name: pantryName.trim() },
  });
  const pantryRow =
    pantry ?? (await db.pantry.create({ data: { name: pantryName.trim(), householdId: household.id } }));

  console.log('Bootstrapped:');
  console.log(`  household  ${household.name} (${household.id})`);
  console.log(`  user       ${user.name} <${user.email}> (${user.id})`);
  console.log(`  pantry     ${pantryRow.name} (${pantryRow.id})`);
  console.log('Log in and invite the rest of the household from the app.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

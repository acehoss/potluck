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
import { OWNER_PRESET } from '../src/server/capabilities';
import {
  firstAvailableHandle,
  slugBaseFromName,
  usernameBaseFromEmail,
} from '../src/server/identity';
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

  // Instance settings exist from the first boot (REWORK D3).
  await db.instanceSettings.upsert({
    where: { id: 'instance' },
    update: {},
    create: { id: 'instance' },
  });

  let household = await db.household.findFirst({ where: { name: householdName.trim() } });
  household ??= await db.household.create({
    data: {
      name: householdName.trim(),
      slug: await firstAvailableHandle(
        slugBaseFromName(householdName),
        async (c) => (await db.household.findUnique({ where: { slug: c } })) !== null,
      ),
    },
  });

  // The very first user of the instance is the instance admin (REWORK A1/A4).
  const isFirstUser = (await db.user.count()) === 0;

  // User + membership in ONE transaction — a half-created (membership-less)
  // user can log in but reads as signed out on every page, and the unique
  // email then blocks the re-run that would repair it.
  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: userName.trim(),
        username: await firstAvailableHandle(
          usernameBaseFromEmail(normalizedEmail),
          async (c) => (await tx.user.findUnique({ where: { username: c } })) !== null,
        ),
        email: normalizedEmail,
        passwordHash,
        isInstanceAdmin: isFirstUser,
      },
    });
    await tx.membership.create({
      data: { userId: created.id, householdId: household.id, ...OWNER_PRESET },
    });
    return created;
  });

  const pantry = await db.pantry.findFirst({
    where: { householdId: household.id, name: pantryName.trim() },
  });
  const pantryRow =
    pantry ?? (await db.pantry.create({ data: { name: pantryName.trim(), householdId: household.id } }));

  console.log('Bootstrapped:');
  console.log(`  household  ${household.name} (${household.id}, @${household.slug})`);
  console.log(`  user       ${user.name} <${user.email}> (@${user.username}${user.isInstanceAdmin ? ', instance admin' : ''})`);
  console.log(`  pantry     ${pantryRow.name} (${pantryRow.id})`);
  console.log('Log in and invite the rest of the household from the app.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

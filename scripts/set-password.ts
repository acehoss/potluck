/**
 * Reset a user's password from the command line — the recovery path for a
 * forgotten password (SPEC §6 requires production-grade auth; there is no
 * self-service email reset in v1). Computes a real argon2id hash (same params
 * as the app) and updates the User row in place.
 *
 * Run it against the live container:
 *   docker compose exec app npx tsx scripts/set-password.ts aaron@example.com "new-password"
 *
 * Existing sessions are NOT revoked (30-day sliding cookies live in the Session
 * table); if you're resetting because of a compromise, also clear that user's
 * rows, e.g. inside `docker compose exec app npx prisma studio`.
 */
import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { hashSync } from '@node-rs/argon2';
import { PrismaClient } from '../src/generated/prisma/client';

const [email, password] = process.argv.slice(2);

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error('usage: npx tsx scripts/set-password.ts <email> <newPassword>');
  process.exit(1);
}

if (!email?.trim()) fail('email is required');
if (!password || password.length < 10) fail('password must be at least 10 characters');

const url = process.env.DATABASE_URL;
if (!url) fail('DATABASE_URL is not set');
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: url! }) });

async function main() {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) fail(`no user with email ${normalizedEmail}`);

  const passwordHash = hashSync(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  await db.user.update({ where: { id: user.id }, data: { passwordHash } });

  console.log(`Password updated for ${user.name} <${normalizedEmail}>.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

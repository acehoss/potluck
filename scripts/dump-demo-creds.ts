/**
 * Print the demo accounts' credentials for one-time authenticator import
 * (Phase 3 Round B; docs/REWORK.md N10). For each seeded account it emits the
 * username/email, the demo password, the `otpauth://` provisioning URI, and a
 * terminal QR — scan it (or import the URI) into 1Password/Authy and the codes
 * it produces match the fixture secret the demo stack boots with.
 *
 * SEED_DEMO-only: the fixture TOTP secrets are committed demo-only material, so
 * this refuses to run outside a demo stack. It reads emails from the DB so the
 * output reflects the actual seeded accounts. It NEVER prints the raw TOTP
 * secret decrypted from the DB — only the committed fixture URI.
 *
 *   docker compose exec app npx tsx scripts/dump-demo-creds.ts
 */
import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import QRCode from 'qrcode';
import { PrismaClient } from '../src/generated/prisma/client';
import { FIXTURE_USERNAMES, demoTotpUri } from '../src/server/mfa/fixtures';

if (process.env.SEED_DEMO !== '1') {
  console.error('Refusing to run: dump-demo-creds is SEED_DEMO-only (fixture secrets are demo material).');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password';

async function main() {
  const users = await db.user.findMany({
    where: { username: { in: FIXTURE_USERNAMES } },
    select: { username: true, email: true, totpEnabledAt: true },
    orderBy: { username: 'asc' },
  });

  console.log('\n=== Potluck demo credentials (SEED_DEMO) ===\n');
  console.log(`Password for every account: ${PASSWORD}\n`);

  for (const u of users) {
    console.log('----------------------------------------------------------------');
    if (u.totpEnabledAt) {
      const uri = demoTotpUri(u.username, u.email);
      const qr = await QRCode.toString(uri, { type: 'terminal', small: true });
      console.log(`  ${u.username}  <${u.email}>   TOTP enrolled: yes`);
      console.log(`  otpauth: ${uri}`);
      console.log(qr);
    } else {
      // Not enrolled (coordinator decision: only aaron boots with TOTP) —
      // password-only. A committed fixture secret still exists for it, so it can
      // be enrolled in-app; we just don't advertise an otpauth here.
      console.log(`  ${u.username}  <${u.email}>   TOTP enrolled: no (password only)`);
    }
  }
  console.log('----------------------------------------------------------------');
  console.log('Scan a QR (or paste the otpauth URI) into your authenticator to');
  console.log('produce live codes that match this stack.\n');
}

main().finally(() => db.$disconnect());

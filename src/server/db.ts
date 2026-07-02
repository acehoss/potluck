import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient, type Prisma } from '@/generated/prisma/client';

/**
 * SQLite runs on one connection, and the better-sqlite3 driver adapter takes
 * its internal mutex only in `startTransaction` — plain queries never acquire
 * it. Without extra serialization, a query from a concurrent request that
 * lands between an interactive transaction's BEGIN and COMMIT executes INSIDE
 * that transaction: it is silently destroyed when the transaction rolls back
 * (finalize's P2002 code-retry rolls back by design), or commits along with
 * it. So every operation goes through one app-level lock, and whole
 * interactive transactions hold that lock for their full duration.
 */
const lockHeld = new AsyncLocalStorage<boolean>();
let lockTail: Promise<unknown> = Promise.resolve();

function withDbLock<T>(fn: () => Promise<T>): Promise<T> {
  if (lockHeld.getStore()) return fn(); // already serialized (inside dbTransaction)
  const run = lockTail.then(() => lockHeld.run(true, fn));
  lockTail = run.catch(() => {});
  return run;
}

function createClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter });
}

// Reuse one client across dev hot reloads.
const globalForPrisma = globalThis as unknown as { prismaBase?: PrismaClient };

const base = globalForPrisma.prismaBase ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prismaBase = base;

/**
 * The app-wide client: every operation is serialized through the lock.
 * NEVER call `db.$transaction` — its inner queries would each take the lock
 * separately, losing atomicity. Use {@link dbTransaction} instead.
 */
export const db = base.$extends({
  query: {
    $allOperations({ args, query }) {
      return withDbLock(() => query(args));
    },
  },
});

/**
 * Interactive transaction that holds the app-level lock for its whole
 * duration, so no other request's query can interleave into it.
 */
export function dbTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withDbLock(() => base.$transaction(fn));
}

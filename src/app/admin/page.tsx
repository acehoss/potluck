import { stat } from 'node:fs/promises';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { resolveImagePath } from '@/server/images';
import { AdminToggle } from './admin-toggle';

/**
 * Instance admin (REWORK A4/D2): trust + visibility, not quotas. Shows
 * per-household OPERATIONAL usage — extraction calls (the operator's API
 * key), image storage (the operator's disk) — plus the A1 growth toggle.
 * Content stays sovereign: no other household's pantry/ledger data here.
 */

async function fileSize(rel: string | null): Promise<number> {
  if (!rel) return 0;
  const abs = resolveImagePath(rel);
  if (!abs) return 0;
  try {
    return (await stat(abs)).size;
  } catch {
    return 0;
  }
}

function formatBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  if (!user.isInstanceAdmin) redirect('/');

  const settings = await db.instanceSettings.findUnique({ where: { id: 'instance' } });
  const households = await db.household.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { memberships: true, pantries: true, items: true } } },
  });

  // Per-household extraction + storage, joined by hand: images hang off
  // restocks (receipt pages, unit photos) and items.
  const restocks = await db.restock.findMany({
    select: {
      extractedAt: true,
      pantry: { select: { householdId: true } },
      images: { select: { path: true } },
      lots: { select: { unitPhotoPath: true } },
    },
  });
  const items = await db.item.findMany({
    select: {
      householdId: true,
      images: { select: { path: true } },
      attachments: { select: { path: true } },
    },
  });

  const rows = await Promise.all(
    households.map(async (h) => {
      const mine = restocks.filter((r) => r.pantry.householdId === h.id);
      const paths = [
        ...mine.flatMap((r) => r.images.map((i) => i.path)),
        ...mine.flatMap((r) => r.lots.map((l) => l.unitPhotoPath)),
        ...items.filter((i) => i.householdId === h.id).flatMap((i) => [
          ...i.images.map((image) => image.path),
          ...i.attachments.map((attachment) => attachment.path),
        ]),
      ];
      const sizes = await Promise.all(paths.map(fileSize));
      return {
        id: h.id,
        name: h.name,
        slug: h.slug,
        members: h._count.memberships,
        pantries: h._count.pantries,
        items: h._count.items,
        restocks: mine.length,
        extractions: mine.filter((r) => r.extractedAt !== null).length,
        storageBytes: sizes.reduce((s, n) => s + n, 0),
      };
    }),
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center gap-3">
        <Link
          href="/more"
          aria-label="Back to More"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-lg text-text-muted transition-colors hover:bg-surface-sunken"
        >
          ←
        </Link>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Instance admin</h1>
          <p className="text-sm text-text-muted">
            Operational usage only — household content stays each household&apos;s own.
          </p>
        </div>
      </header>

      <main className="flex flex-col gap-4">
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
          <h2 className="text-lg font-semibold">Growth</h2>
          <AdminToggle allow={settings?.allowMemberHouseholdInvites ?? true} />
        </section>

        <section className="flex flex-col gap-1 rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
          <h2 className="text-lg font-semibold">Usage by household</h2>
          <p className="text-sm text-text-muted">
            Extractions spend your Anthropic API key (~3¢ each); images live on this
            server&apos;s disk. High numbers are a conversation, not a cutoff.
          </p>
          <ul className="mt-2 flex flex-col">
            {rows.map((row) => (
              <li
                key={row.id}
                data-testid="admin-usage-row"
                className="flex flex-col gap-0.5 border-b border-border py-3 last:border-b-0"
              >
                <p className="font-medium text-text">
                  {row.name} <span className="text-xs text-text-muted">@{row.slug}</span>
                </p>
                <p className="text-sm text-text-muted">
                  {row.members} member{row.members === 1 ? '' : 's'} · {row.pantries}{' '}
                  {row.pantries === 1 ? 'pantry' : 'pantries'} · {row.restocks} restocks ·{' '}
                  {row.items} items
                </p>
                <p className="text-sm text-text-muted">
                  {row.extractions} extraction{row.extractions === 1 ? '' : 's'} (~$
                  {(row.extractions * 0.03).toFixed(2)}) · {formatBytes(row.storageBytes)} of
                  images
                </p>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

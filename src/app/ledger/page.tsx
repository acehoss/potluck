import { redirect } from 'next/navigation';
import { restockCode } from '@/lib/domain';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { netByCounterparty } from '@/server/ledger';
import { LedgerView, type LedgerRow } from './ledger-view';

/**
 * The render timestamp plus this viewer's per-pair "seen" watermark. A loader
 * (not inline render code) so Date.now() stays out of the component body
 * (react-hooks/purity); callers must invoke it BEFORE snapshotting the entry
 * list so markSeen can never cover an entry the page didn't show.
 */
async function loadSeenWatermark(userId: string, counterpartyHouseholdId: string) {
  const renderedAt = Date.now();
  const seen = await db.ledgerSeen.findUnique({
    where: { userId_counterpartyHouseholdId: { userId, counterpartyHouseholdId } },
  });
  return { renderedAt, seenAt: seen?.seenAt ?? null };
}

/**
 * Ledger tab (blueprint 02): one net number per household pair, hero first,
 * then the append-only entry list newest-first. Server component reading
 * Prisma directly (slice-1 convention); undo goes through tRPC.
 */
export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ with?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { with: withParam } = await searchParams;
  const households = await db.household.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  const me = user.householdId;
  const others = households.filter((h) => h.id !== me);
  const other = others.find((h) => h.id === withParam) ?? others[0] ?? null;

  if (!other) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-24 sm:p-6 sm:pb-24">
        <h1 className="text-xl font-semibold tracking-tight">Ledger</h1>
        <p className="text-sm text-text-muted">
          No other households yet — the ledger tracks balances between households.
        </p>
      </div>
    );
  }

  // Loaded BEFORE the entry list is snapshotted: renderedAt is what the
  // client echoes to markSeen, so an entry created after this moment (and
  // therefore possibly absent from the rendered rows) can never be marked
  // seen by this visit.
  const { renderedAt, seenAt } = await loadSeenWatermark(user.id, other.id);

  const entries = await db.ledgerEntry.findMany({
    where: {
      OR: [
        { creditorHouseholdId: me, debtorHouseholdId: other.id },
        { creditorHouseholdId: other.id, debtorHouseholdId: me },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
  const netCents = (await netByCounterparty(me)).get(other.id) ?? 0;

  // LedgerEntry is relation-free (blueprint 01): enrich by hand.
  const takeIds = entries.flatMap((e) => (e.takeId ? [e.takeId] : []));
  const takes = await db.take.findMany({
    where: { id: { in: takeIds } },
    include: {
      lot: {
        select: {
          product: { select: { name: true } },
          restockId: true,
          restock: { select: { dateCode: true, seq: true } },
        },
      },
      taker: { select: { name: true, householdId: true } },
    },
  });
  const takeById = new Map(takes.map((t) => [t.id, t]));

  const restockIds = entries.flatMap((e) => (e.restockId ? [e.restockId] : []));
  const restocks = await db.restock.findMany({
    where: { id: { in: restockIds } },
    select: { id: true, retailer: true, dateCode: true, seq: true },
  });
  const restockById = new Map(restocks.map((r) => [r.id, r]));

  const creators = await db.user.findMany({
    where: { id: { in: [...new Set(entries.map((e) => e.createdById))] } },
    select: { id: true, name: true, householdId: true },
  });
  const creatorById = new Map(creators.map((u) => [u.id, u]));
  const entryById = new Map(entries.map((e) => [e.id, e]));

  // "New since viewed" (blueprint 01 slice 4): created after this viewer's
  // last look at THIS pair's ledger, by anyone but the viewer — blueprint 02
  // flags a settlement for BOTH households until viewed, so the recorder's
  // housemates see it too; only the creating user is excluded. Computed
  // against the per-pair watermark from BEFORE this render — the client marks
  // seen after mount, so the highlight survives the visit it's first shown on.
  const isNewEntry = (entry: { createdAt: Date; createdById: string }) =>
    (seenAt === null || entry.createdAt > seenAt) && entry.createdById !== user.id;

  const rows: LedgerRow[] = entries.map((entry) => {
    let label: string;
    let filterGroup: LedgerRow['filterGroup'] = 'other';
    let restockId = entry.restockId;
    let take: LedgerRow['take'] = null;

    const describeTake = (takeId: string) => {
      const t = takeById.get(takeId);
      return t ? `${t.quantity}× ${t.lot.product.name}` : 'take';
    };

    switch (entry.type) {
      case 'TAKE': {
        label = `Take ${describeTake(entry.takeId!)}`;
        filterGroup = 'take';
        const t = takeById.get(entry.takeId!);
        if (t) {
          restockId = t.lot.restockId;
          take = {
            id: t.id,
            reversed: t.reversedAt !== null,
            canUndo: t.reversedAt === null && t.taker.householdId === me,
          };
        }
        break;
      }
      case 'RESTOCK_CREDIT': {
        const r = entry.restockId ? restockById.get(entry.restockId) : undefined;
        const code =
          r?.dateCode && r.seq !== null ? ` ${restockCode(r.dateCode, r.seq!)}` : '';
        label = `Restock credit · ${r?.retailer ?? 'restock'}${code}`;
        filterGroup = 'credit';
        break;
      }
      case 'REVERSAL': {
        const reversed = entry.reversesId ? entryById.get(entry.reversesId) : undefined;
        if (reversed?.type === 'TAKE' && reversed.takeId) {
          label = `Undo take ${describeTake(reversed.takeId)}`;
          filterGroup = 'take';
          restockId = takeById.get(reversed.takeId)?.lot.restockId ?? null;
        } else {
          label = 'Reversal';
          filterGroup = reversed?.type === 'RESTOCK_CREDIT' ? 'credit' : 'other';
        }
        break;
      }
      case 'SETTLEMENT':
        // Blueprint 02 sketch: "06/28 Settlement Venmo -$40" — method inline.
        label = entry.note ? `Settlement · ${entry.note}` : 'Settlement';
        filterGroup = 'payment';
        break;
      case 'ADJUSTMENT':
        label = 'Manual adjustment';
        filterGroup = 'payment';
        break;
      default:
        label = entry.type;
    }

    return {
      id: entry.id,
      createdAt: entry.createdAt.toISOString(),
      // Signed from the viewer's side: positive = money owed to you.
      amountCents: entry.creditorHouseholdId === me ? entry.amountCents : -entry.amountCents,
      label,
      filterGroup,
      note: entry.note,
      createdByName: creatorById.get(entry.createdById)?.name ?? 'someone',
      restockId,
      take,
      isNew: isNewEntry(entry),
    };
  });

  return (
    <LedgerView
      other={other}
      others={others}
      yourName={user.name}
      yourHouseholdId={me}
      netCents={netCents}
      rows={rows}
      renderedAt={renderedAt}
    />
  );
}

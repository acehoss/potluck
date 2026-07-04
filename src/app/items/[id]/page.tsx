import { notFound, redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { ItemDetailView, type ItemDetail } from './item-detail-view';

/** Item detail (blueprint 02 lending): photo, notes, fee, status, history. */
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const item = await db.item.findUnique({
    where: { id },
    include: {
      household: { select: { id: true, name: true } },
      loans: {
        orderBy: { outAt: 'desc' },
        include: { borrower: { select: { name: true } } },
      },
    },
  });
  if (!item) notFound();

  // Borrower household = the checkout-time snapshot on each loan (REWORK A3);
  // resolve names in one lookup.
  const borrowerHouseholds = await db.household.findMany({
    where: { id: { in: [...new Set(item.loans.map((l) => l.borrowerHouseholdId))] } },
    select: { id: true, name: true },
  });
  const householdNames = new Map(borrowerHouseholds.map((h) => [h.id, h.name]));

  // A LOAN_FEE that undoCheckout reversed nets $0 (invariant 10 / append-only
  // ledger): history must say so instead of permanently claiming the charge.
  // LedgerEntry is relation-free, so join by hand: fee entries for these
  // loans, then REVERSALs referencing those entries.
  const feeEntries = await db.ledgerEntry.findMany({
    where: { loanId: { in: item.loans.map((l) => l.id) } },
    select: { id: true, loanId: true },
  });
  const reversedEntryIds = new Set(
    (
      await db.ledgerEntry.findMany({
        where: { type: 'REVERSAL', reversesId: { in: feeEntries.map((e) => e.id) } },
        select: { reversesId: true },
      })
    ).map((r) => r.reversesId!),
  );
  const reversedLoanIds = new Set(
    feeEntries.filter((e) => reversedEntryIds.has(e.id)).map((e) => e.loanId!),
  );

  const detail: ItemDetail = {
    id: item.id,
    name: item.name,
    photoPath: item.photoPath,
    notes: item.notes,
    feeCents: item.feeCents,
    householdId: item.household.id,
    householdName: item.household.name,
    isYours: item.household.id === user.householdId,
    loans: item.loans.map((loan) => ({
      id: loan.id,
      borrowerName: loan.borrower.name,
      borrowerHouseholdId: loan.borrowerHouseholdId,
      borrowerHouseholdName: householdNames.get(loan.borrowerHouseholdId) ?? 'Unknown',
      // The fee that actually posted (invariant 10): own-household loans and
      // $0-fee items charge nothing regardless of the snapshot.
      chargedFeeCents:
        loan.borrowerHouseholdId === item.household.id ? 0 : loan.feeCents,
      // …and a fee whose LOAN_FEE entry was reversed by undoCheckout netted
      // $0 — the row is annotated so history never claims money moved.
      feeReversed: reversedLoanIds.has(loan.id),
      outAt: loan.outAt.toISOString(),
      dueAt: loan.dueAt?.toISOString() ?? null,
      returnedAt: loan.returnedAt?.toISOString() ?? null,
      conditionReturned: loan.conditionReturned,
    })),
  };

  return <ItemDetailView item={detail} yourHouseholdId={user.householdId} />;
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatCents } from '@/lib/money';
import { getSessionUser } from '@/server/auth';
import { activeConnectionsOf, visibleUnderCircle } from '@/server/authz';
import { type ContactMember, loadContactHousehold } from '@/server/contacts';
import { db } from '@/server/db';
import { netByCounterparty } from '@/server/ledger';
import { NeighborsAttention } from './neighbors-attention';
import { NeighborsShares } from './neighbors-shares';
import { Avatar } from './more/profile-card';

/**
 * Neighbors — the home tab (Phase-2 P1/P2, the IA flip). Leads with the network:
 * an attention strip (same source as the bell) and needs/surpluses first, then
 * one section per connected household with the net balance, lending, and member
 * cards. The acting household's OWN pantries/items/recipes now live on the Home
 * tab; pair ledgers + settle live behind each balance link (P3 — "less about
 * money"). SEVERED pairs with a nonzero balance still render so the debt stays
 * settleable (B6).
 */

/** "just now" / "3h ago" / "5d ago" / "Mar 3" for a recent-activity timestamp. */
function agoLabel(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type Section = {
  id: string;
  name: string;
  slug: string;
  net: number; // + = they owe you; − = you owe them
  lastAt: Date | null;
  lentToThem: number;
  borrowedFromThem: number;
  members: ContactMember[];
  pantries: { id: string; name: string }[];
  severed: boolean;
};

export default async function NeighborsPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const me = user.householdId;

  const connections = await activeConnectionsOf(db, me);
  const activeIds = connections.map((c) => c.counterpartyId);
  const net = await netByCounterparty(me);

  // SEVERED pairs still owe/are-owed: keep a section so settlement stays reachable
  // (B6 — the net survives forever). Skip any that are somehow also active.
  const severedIds = (
    await db.connection.findMany({
      where: { status: 'SEVERED', OR: [{ householdAId: me }, { householdBId: me }] },
      select: { householdAId: true, householdBId: true },
    })
  )
    .map((e) => (e.householdAId === me ? e.householdBId : e.householdAId))
    .filter((id) => (net.get(id) ?? 0) !== 0 && !activeIds.includes(id));

  const counterpartyIds = [...activeIds, ...severedIds];

  // Names/slugs for every section household in one query.
  const hh = await db.household.findMany({
    where: { id: { in: counterpartyIds } },
    select: { id: true, name: true, slug: true },
  });
  const hhById = new Map(hh.map((h) => [h.id, h]));

  // Age of the last ledger entry per counterparty — one pass over my entries.
  const entries = await db.ledgerEntry.findMany({
    where: { OR: [{ creditorHouseholdId: me }, { debtorHouseholdId: me }] },
    select: { creditorHouseholdId: true, debtorHouseholdId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const lastAt = new Map<string, Date>();
  for (const e of entries) {
    const other = e.creditorHouseholdId === me ? e.debtorHouseholdId : e.creditorHouseholdId;
    if (!lastAt.has(other)) lastAt.set(other, e.createdAt);
  }

  // Active loans either direction, bucketed by counterparty.
  const loans = await db.loan.findMany({
    where: { returnedAt: null, OR: [{ borrowerHouseholdId: me }, { item: { householdId: me } }] },
    select: { borrowerHouseholdId: true, item: { select: { householdId: true } } },
  });
  const lentToThem = new Map<string, number>();
  const borrowed = new Map<string, number>();
  for (const l of loans) {
    const owner = l.item.householdId;
    if (owner === me && l.borrowerHouseholdId !== me) {
      lentToThem.set(l.borrowerHouseholdId, (lentToThem.get(l.borrowerHouseholdId) ?? 0) + 1);
    } else if (l.borrowerHouseholdId === me && owner !== me) {
      borrowed.set(owner, (borrowed.get(owner) ?? 0) + 1);
    }
  }

  // Visible members per ACTIVE counterparty (the P5 contact rule; severed edges
  // never show member cards).
  const membersById = new Map<string, ContactMember[]>();
  for (const id of activeIds) {
    try {
      membersById.set(id, (await loadContactHousehold(db, me, id)).members);
    } catch {
      membersById.set(id, []);
    }
  }

  // Connected households' SHARED PANTRIES the acting household may browse — the
  // cross-household order-creation entry point (order.addToCart runs from the
  // pantry page). Reuses the exact grant + circle/SELECT visibility scan the
  // pre-flip home had: a counterparty's pantry shows iff they grant us `pantry`
  // AND the pantry is visible to the circle they placed us in.
  const circleByCounterparty = new Map(connections.map((c) => [c.counterpartyId, c.theirCircleId]));
  const pantryGranterIds = connections.filter((c) => c.theyGrant.pantry).map((c) => c.counterpartyId);
  const theirCircleIds = pantryGranterIds
    .map((id) => circleByCounterparty.get(id))
    .filter((id): id is string => id != null);
  const scopedPantryKeys = new Set(
    theirCircleIds.length
      ? (
          await db.pantryCircle.findMany({
            where: { circleId: { in: theirCircleIds } },
            select: { pantryId: true, circleId: true },
          })
        ).map((r) => `${r.pantryId}:${r.circleId}`)
      : [],
  );
  const granterPantries = pantryGranterIds.length
    ? await db.pantry.findMany({
        where: { householdId: { in: pantryGranterIds } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, householdId: true, visibility: true },
      })
    : [];
  const pantriesById = new Map<string, { id: string; name: string }[]>();
  for (const p of granterPantries) {
    const circleId = circleByCounterparty.get(p.householdId);
    if (!circleId) continue;
    if (!visibleUnderCircle(p.visibility, scopedPantryKeys.has(`${p.id}:${circleId}`))) continue;
    const list = pantriesById.get(p.householdId) ?? [];
    list.push({ id: p.id, name: p.name });
    pantriesById.set(p.householdId, list);
  }

  const build = (id: string, severed: boolean): Section | null => {
    const h = hhById.get(id);
    if (!h) return null;
    return {
      id,
      name: h.name,
      slug: h.slug,
      net: net.get(id) ?? 0,
      lastAt: lastAt.get(id) ?? null,
      lentToThem: lentToThem.get(id) ?? 0,
      borrowedFromThem: borrowed.get(id) ?? 0,
      members: membersById.get(id) ?? [],
      pantries: pantriesById.get(id) ?? [],
      severed,
    };
  };
  const sections = [
    ...activeIds.map((id) => build(id, false)),
    ...severedIds.map((id) => build(id, true)),
  ]
    .filter((s): s is Section => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Neighbors</h1>
        <p className="text-sm text-text-muted">{user.name}</p>
      </header>

      <NeighborsAttention />
      <NeighborsShares />

      {sections.length === 0 ? (
        <section
          data-testid="neighbors-empty"
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center"
        >
          <p className="text-4xl" aria-hidden>
            🤝
          </p>
          <p className="text-base font-medium text-text">No neighbors yet.</p>
          <p className="text-sm text-text-muted">
            Connect with a household to share pantries, lend and borrow, and pass needs &amp;
            surpluses back and forth.
          </p>
          <Link
            href="/more"
            className="mt-1 min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
          >
            Connect a household
          </Link>
        </section>
      ) : (
        <div className="flex flex-col gap-4">
          {sections.map((s) => (
            <HouseholdSection key={s.id} section={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function netPhrase(n: number, name: string): { text: string; className: string } {
  if (n > 0) return { text: `${name} owes you ${formatCents(n)}`, className: 'text-success' };
  if (n < 0) return { text: `You owe ${name} ${formatCents(-n)}`, className: 'text-danger' };
  return { text: `Even with ${name}`, className: 'text-text-muted' };
}

function HouseholdSection({ section: s }: { section: Section }) {
  const phrase = netPhrase(s.net, s.name);
  const lending: string[] = [];
  if (s.lentToThem > 0) lending.push(`${s.lentToThem} on loan to them`);
  if (s.borrowedFromThem > 0) lending.push(`${s.borrowedFromThem} borrowed`);

  return (
    <section
      data-testid="neighbors-household-section"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        {s.severed ? (
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-text">{s.name}</h2>
            <p className="text-xs text-text-muted">connection ended · balance stays settleable</p>
          </div>
        ) : (
          <Link href={`/households/${s.id}`} data-testid="people-contact-link" className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-text">{s.name}</h2>
            <p className="truncate text-xs text-text-muted">@{s.slug}</p>
          </Link>
        )}
      </div>

      <Link
        href={`/ledger?with=${s.id}`}
        data-testid="neighbors-balance"
        className="flex items-center justify-between gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm"
      >
        <span className={`font-medium ${phrase.className}`}>{phrase.text}</span>
        <span className="shrink-0 text-xs text-text-muted">
          {s.lastAt ? agoLabel(s.lastAt) : 'no activity'} →
        </span>
      </Link>

      {lending.length > 0 && (
        <Link
          href="/items"
          data-testid="neighbors-lending"
          className="text-sm text-text-muted hover:text-text"
        >
          🔧 {lending.join(' · ')} →
        </Link>
      )}

      {!s.severed && s.pantries.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Shared pantries
          </p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {s.pantries.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/pantries/${p.id}`}
                  data-testid="neighbors-pantry-row"
                  className="flex min-h-11 items-center justify-between gap-2 px-3 py-2 text-sm text-text hover:bg-surface-sunken"
                >
                  <span className="min-w-0 truncate">🧺 {p.name}</span>
                  <span className="shrink-0 text-text-muted">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!s.severed && s.members.length > 0 && (
        <ul className="flex flex-wrap gap-3 pt-1">
          {s.members.map((m) => (
            <li key={m.membershipId}>
              <Link
                href={`/households/${s.id}`}
                data-testid="neighbors-member"
                className="flex items-center gap-2"
              >
                <Avatar photoPath={m.photoPath} name={m.name} className="size-8" />
                <span className="text-sm text-text">{m.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

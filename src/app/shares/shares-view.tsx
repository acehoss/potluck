'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { BackLink } from '@/app/nav-history';
import { newClientKey } from '@/lib/client-key';
import { downscaleToJpeg, uploadImage } from '@/lib/downscale';
import { useTRPC } from '@/lib/trpc';

/**
 * Needs & surpluses board (REWORK F). A calm feed of gifts between connected
 * households — money NEVER changes hands here. Everything runs through the
 * tRPC share.feed query; every mutation invalidates it. Money-adjacent
 * mutations (create / claim / confirm / reshare) carry a clientKey so a
 * double-tap or a retry replays as one action.
 */

export type ShareableLot = { id: string; productName: string; code: string; available: number };

type FeedPost = {
  id: string;
  type: 'NEED' | 'SURPLUS';
  title: string;
  description: string | null;
  photoPath: string | null;
  quantity: number | null;
  unit: string | null;
  remaining: number | null;
  expiresAt: string;
  status: 'OPEN' | 'CLAIMED' | 'FULFILLED' | 'EXPIRED';
  visibility: string;
  mine: boolean;
  isReshare: boolean;
  poster: { householdId: string; householdName: string };
  canReshare: boolean;
  hopsRemaining: number;
  myClaim: { id: string; status: string; quantity: number | null } | null;
  claims?: {
    id: string;
    householdName: string;
    quantity: number | null;
    note: string | null;
    status: string;
    createdAt: string;
  }[];
};

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

/** Local YYYY-MM-DD for a Date that many days out (date-input value). */
function dateInputValue(daysOut: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysOut);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** A date-only input → an ISO instant at local noon (dodges TZ midnight drift). */
function dateInputToIso(value: string) {
  return new Date(`${value}T12:00:00`).toISOString();
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function SharesView({ lots }: { lots: ShareableLot[] }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const feed = useQuery(trpc.share.feed.queryOptions());

  const [composeOpen, setComposeOpen] = useState(false);
  const [claimFor, setClaimFor] = useState<FeedPost | null>(null);

  const invalidate = () => queryClient.invalidateQueries(trpc.share.feed.pathFilter());

  const posts = (feed.data?.posts ?? []) as FeedPost[];
  const mine = posts.filter((p) => p.mine);
  const theirs = posts.filter((p) => !p.mine);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <BackLink fallback="/" />
          <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
            Needs &amp; surpluses
          </h1>
        </div>
        <p className="pl-8 text-sm text-text-muted">
          Gifts between connected households — money never changes hands.
        </p>
      </header>

      <button
        type="button"
        data-testid="share-compose-open"
        onClick={() => setComposeOpen(true)}
        className="min-h-14 rounded-xl border border-dashed border-border-strong px-4 py-3 text-left text-base font-medium text-text-muted transition-colors hover:bg-surface-sunken"
      >
        Share a surplus or post a need…
      </button>

      {posts.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
          <p className="text-4xl" aria-hidden>
            🫙
          </p>
          <p className="text-base font-medium text-text">Nothing on offer right now.</p>
          <p className="text-sm text-text-muted">
            Post a surplus when you&apos;ve made too much, or ask for something you need.
          </p>
        </div>
      )}

      {mine.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Yours</h2>
          <div className="flex flex-col gap-2">
            {mine.map((p) => (
              <ShareCard key={p.id} post={p} onClaim={setClaimFor} onChanged={invalidate} />
            ))}
          </div>
        </section>
      )}

      {theirs.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
            From your connections
          </h2>
          <div className="flex flex-col gap-2">
            {theirs.map((p) => (
              <ShareCard key={p.id} post={p} onClaim={setClaimFor} onChanged={invalidate} />
            ))}
          </div>
        </section>
      )}

      {composeOpen && (
        <ComposeSheet
          lots={lots}
          onClose={() => setComposeOpen(false)}
          onDone={() => {
            setComposeOpen(false);
            invalidate();
          }}
        />
      )}

      {claimFor && (
        <ClaimSheet
          post={claimFor}
          onClose={() => setClaimFor(null)}
          onDone={() => {
            setClaimFor(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: 'NEED' | 'SURPLUS' }) {
  return type === 'NEED' ? (
    <span className="shrink-0 rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-medium text-warn">
      Need
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
      Surplus
    </span>
  );
}

/** One post card, with the action set derived from the DTO flags. */
function ShareCard({
  post,
  onClaim,
  onChanged,
}: {
  post: FeedPost;
  onClaim: (post: FeedPost) => void;
  onChanged: () => void;
}) {
  const trpc = useTRPC();
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per claim answered — a confirm posts the $0 gift, so a
  // replay must not re-gift; keys are stable across a card's lifetime.
  const confirmKeys = useRef(new Map<string, string>());
  const keyFor = (id: string) => {
    let k = confirmKeys.current.get(id);
    if (!k) {
      k = newClientKey();
      confirmKeys.current.set(id, k);
    }
    return k;
  };
  const onError = (e: { message: string }) => setError(e.message);

  const cancelClaim = useMutation(
    trpc.share.cancelClaim.mutationOptions({ onSuccess: onChanged, onError }),
  );
  const withdraw = useMutation(
    trpc.share.withdraw.mutationOptions({ onSuccess: onChanged, onError }),
  );
  const reshare = useMutation(trpc.share.reshare.mutationOptions({ onSuccess: onChanged, onError }));
  const respond = useMutation(trpc.share.respond.mutationOptions({ onSuccess: onChanged, onError }));

  const counted = post.quantity != null;
  const openClaims = (post.claims ?? []).filter((c) => c.status === 'PENDING');
  const historyClaims = (post.claims ?? []).filter((c) => c.status !== 'PENDING');

  const pillBtn =
    'min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

  return (
    <article
      data-testid="share-row"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">
        {post.photoPath && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/images/${post.photoPath}`}
            alt=""
            className="size-16 shrink-0 rounded-lg border border-border object-cover"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <TypeBadge type={post.type} />
            {post.status !== 'OPEN' && (
              <span
                data-testid="share-status"
                className="shrink-0 rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-text-muted"
              >
                {post.status.toLowerCase()}
              </span>
            )}
            {post.mine && post.visibility === 'SELECT' && (
              <span
                data-testid="share-limited-chip"
                className="shrink-0 rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-text-muted"
                title="Only some of your circles can see this post"
              >
                Some circles
              </span>
            )}
          </div>
          <p className="text-base font-medium text-text">{post.title}</p>
          {post.description && <p className="text-sm text-text-muted">{post.description}</p>}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
            <span>{post.mine ? 'You' : post.poster.householdName}</span>
            {post.isReshare && <span className="text-text-muted">· reshared</span>}
            {counted && (
              <span>
                · {post.quantity} {post.unit ?? 'units'} ({post.remaining ?? 0} left)
              </span>
            )}
            <span>· ends {shortDate(post.expiresAt)}</span>
          </p>
        </div>
      </div>

      {/* Actions on someone else's post. */}
      {!post.mine && (
        <div className="flex flex-wrap gap-2">
          {!post.myClaim && post.status === 'OPEN' && (
            <button
              type="button"
              data-testid="share-claim-open"
              onClick={() => {
                setError(null);
                onClaim(post);
              }}
              className={pillBtn}
            >
              Claim
            </button>
          )}
          {post.myClaim?.status === 'PENDING' && (
            <>
              <span className="flex min-h-11 items-center text-sm font-medium text-accent-strong">
                You claimed this
              </span>
              <button
                type="button"
                data-testid="share-claim-cancel"
                disabled={cancelClaim.isPending}
                onClick={() => cancelClaim.mutate({ claimId: post.myClaim!.id })}
                className={pillBtn}
              >
                Cancel claim
              </button>
            </>
          )}
          {post.canReshare && (
            <button
              type="button"
              data-testid="share-reshare"
              disabled={reshare.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "You'll repost this to YOUR connections under your name and hand it off " +
                      'yourself — the original poster stays private. Pass it on?',
                  )
                ) {
                  setError(null);
                  reshare.mutate({ postId: post.id, clientKey: keyFor(`reshare:${post.id}`) });
                }
              }}
              className={pillBtn}
            >
              Pass it on
            </button>
          )}
        </div>
      )}

      {/* Owner controls. */}
      {post.mine && (
        <div className="flex flex-col gap-3">
          {openClaims.length > 0 && (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {openClaims.map((c) => (
                <li
                  key={c.id}
                  data-testid="claim-row"
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">
                      {c.householdName}
                      {c.quantity != null && (
                        <span className="font-normal text-text-muted"> · wants {c.quantity}</span>
                      )}
                    </p>
                    {c.note && <p className="text-sm text-text-muted">“{c.note}”</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      data-testid="share-confirm"
                      disabled={respond.isPending}
                      onClick={() => {
                        setError(null);
                        respond.mutate({
                          claimId: c.id,
                          action: 'confirm',
                          clientKey: keyFor(c.id),
                        });
                      }}
                      className="min-h-11 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
                    >
                      Confirm handoff
                    </button>
                    <button
                      type="button"
                      data-testid="share-release"
                      disabled={respond.isPending}
                      onClick={() => {
                        setError(null);
                        respond.mutate({
                          claimId: c.id,
                          action: 'release',
                          clientKey: keyFor(c.id),
                        });
                      }}
                      className="min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
                    >
                      Release
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {historyClaims.length > 0 && (
            <ul className="flex flex-col gap-1">
              {historyClaims.map((c) => (
                <li key={c.id} data-testid="claim-row" className="text-sm text-text-muted">
                  {c.status === 'CONFIRMED' ? '✓ handed to' : '· released'} {c.householdName}
                  {c.quantity != null && <> ({c.quantity})</>}
                </li>
              ))}
            </ul>
          )}
          {(post.status === 'OPEN' || post.status === 'CLAIMED') && (
            <button
              type="button"
              data-testid="share-withdraw"
              disabled={withdraw.isPending}
              onClick={() => {
                if (window.confirm('Withdraw this post? Any pending claims can no longer be confirmed.')) {
                  setError(null);
                  withdraw.mutate({ postId: post.id });
                }
              }}
              className="min-h-11 self-start rounded-lg border border-danger/40 px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
            >
              Withdraw
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </article>
  );
}

/** Claim sheet: a quantity only for counted posts, optional note. */
function ClaimSheet({
  post,
  onClose,
  onDone,
}: {
  post: FeedPost;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const [clientKey] = useState(newClientKey);
  const counted = post.quantity != null;
  const max = post.remaining ?? 0;
  const [qty, setQty] = useState(() => (counted ? Math.min(1, max) || 1 : 1));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const claim = useMutation(
    trpc.share.claim.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  const stepperBtn =
    'flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="share-claim-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          claim.mutate({
            postId: post.id,
            quantity: counted ? qty : undefined,
            note: note.trim() || undefined,
            clientKey,
          });
        }}
      >
        <h2 className="text-lg font-semibold">Claim: {post.title}</h2>
        <p className="text-sm text-text-muted">
          This tells {post.poster.householdName} you&apos;d like it — they confirm the handoff. It
          stays a gift; nothing is owed.
        </p>

        {counted && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-text">
              How many? <span className="font-normal text-text-muted">({max} left)</span>
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Fewer"
                disabled={qty <= 1}
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                className={stepperBtn}
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={max}
                data-testid="share-claim-qty"
                aria-label="Quantity to claim"
                value={qty}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setQty(Number.isInteger(n) && n >= 1 ? Math.min(n, max) : 1);
                }}
                className={`${inputClass} w-20 text-center font-mono tabular-nums`}
              />
              <button
                type="button"
                aria-label="More"
                disabled={qty >= max}
                onClick={() => setQty((q) => Math.min(max, q + 1))}
                className={stepperBtn}
              >
                +
              </button>
            </div>
          </div>
        )}

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Note (optional)
          <input
            type="text"
            data-testid="share-claim-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Can swing by after 5"
            className={inputClass}
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button
            type="submit"
            data-testid="share-claim-submit"
            disabled={claim.isPending}
            className={primaryBtn}
          >
            {claim.isPending ? 'Claiming…' : 'Claim'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Composer: post a NEED or SURPLUS; a surplus may link own pantry lots. */
function ComposeSheet({
  lots,
  onClose,
  onDone,
}: {
  lots: ShareableLot[];
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const fileRef = useRef<HTMLInputElement>(null);
  const [clientKey] = useState(newClientKey);
  const [type, setType] = useState<'SURPLUS' | 'NEED'>('SURPLUS');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  // Prefill the server defaults (surplus +3d, need +14d); re-defaulted on toggle
  // unless the poster has already picked a date.
  const [expiry, setExpiry] = useState(() => dateInputValue(3));
  const [expiryTouched, setExpiryTouched] = useState(false);
  const [hops, setHops] = useState(1);
  const [selectedLots, setSelectedLots] = useState<Set<string>>(new Set());
  const [lotsOpen, setLotsOpen] = useState(false);
  const [photo, setPhoto] = useState<{ path: string; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Audience: default ALL (reach every circle we grant shareTo — today's
  // behavior, no circleIds sent). SELECT scopes to a chosen subset.
  const [audience, setAudience] = useState<'ALL' | 'SELECT'>('ALL');
  const [audienceCircles, setAudienceCircles] = useState<Set<string>>(new Set());

  // circle.names is any-member; filter client-side to circles that actually
  // carry the shareTo grant — the only ones a post can reach.
  const circles = useQuery(trpc.circle.names.queryOptions());
  const shareToCircles = (circles.data?.circles ?? []).filter((c) => c.shareTo);

  const create = useMutation(
    trpc.share.create.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  function pickType(next: 'SURPLUS' | 'NEED') {
    setType(next);
    if (next !== 'SURPLUS') setSelectedLots(new Set());
    if (!expiryTouched) setExpiry(dateInputValue(next === 'SURPLUS' ? 3 : 14));
  }

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const jpeg = await downscaleToJpeg(file);
      const { path } = await uploadImage('shares', jpeg);
      if (photo) URL.revokeObjectURL(photo.preview);
      setPhoto({ path, preview: URL.createObjectURL(jpeg) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const hasQty = qty.trim() !== '';
  // In SELECT mode a post must reach at least one circle, or it reaches nobody.
  const audienceIncomplete =
    shareToCircles.length > 0 && audience === 'SELECT' && audienceCircles.size === 0;
  const typeBtn = (active: boolean) =>
    `min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      active
        ? 'bg-accent text-accent-contrast'
        : 'border border-border-strong text-text hover:bg-surface-sunken'
    }`;

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="share-compose-sheet"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          const quantity = hasQty ? Number(qty) : undefined;
          if (hasQty && (!Number.isInteger(quantity) || (quantity ?? 0) < 1)) {
            setError('Quantity must be a whole number.');
            return;
          }
          create.mutate({
            type,
            title: title.trim(),
            description: description.trim() || undefined,
            quantity,
            unit: hasQty && unit.trim() ? unit.trim() : undefined,
            expiresAt: dateInputToIso(expiry),
            // Scoped posts can't be reshared — store 0 hops so the row matches
            // what the composer showed (the server refuses reshare regardless).
            hopsAllowance: shareToCircles.length > 0 && audience === 'SELECT' ? 0 : hops,
            stockIds: type === 'SURPLUS' && selectedLots.size ? [...selectedLots] : undefined,
            photoPath: photo?.path,
            circleIds:
              shareToCircles.length > 0 && audience === 'SELECT'
                ? [...audienceCircles]
                : undefined,
            clientKey,
          });
        }}
      >
        <h2 className="text-lg font-semibold">Post to your connections</h2>

        <div className="flex gap-2" role="radiogroup" aria-label="Post type">
          <button
            type="button"
            role="radio"
            aria-checked={type === 'SURPLUS'}
            data-testid="share-type-surplus"
            onClick={() => pickType('SURPLUS')}
            className={typeBtn(type === 'SURPLUS')}
          >
            I have a surplus
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={type === 'NEED'}
            data-testid="share-type-need"
            onClick={() => pickType('NEED')}
            className={typeBtn(type === 'NEED')}
          >
            I need something
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Title
          <input
            type="text"
            required
            data-testid="share-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={type === 'SURPLUS' ? 'Extra sourdough loaves' : 'A cup of buttermilk'}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Description (optional)
          <textarea
            data-testid="share-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className={`${inputClass} resize-none`}
          />
        </label>

        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-text">
            Quantity (optional)
            <input
              type="number"
              inputMode="numeric"
              min={1}
              data-testid="share-qty"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="—"
              className={inputClass}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-text">
            Unit (optional)
            <input
              type="text"
              data-testid="share-unit"
              value={unit}
              disabled={!hasQty}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="loaves"
              className={`${inputClass} disabled:opacity-50`}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Ends on
          <input
            type="date"
            data-testid="share-expiry"
            value={expiry}
            onChange={(e) => {
              setExpiry(e.target.value);
              setExpiryTouched(true);
            }}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          May connections pass this on?
          {/* A circle-scoped post can never be reshared (the server refuses),
              so the hops choice is moot in SELECT mode — disable it rather
              than let "Family only + 2 hops" read as a contradiction. */}
          <select
            data-testid="share-hops"
            value={audience === 'SELECT' ? 0 : hops}
            disabled={audience === 'SELECT'}
            onChange={(e) => setHops(Number(e.target.value))}
            className={`${inputClass} disabled:opacity-50`}
          >
            <option value={0}>
              {audience === 'SELECT' ? 'No — limited posts stay put' : 'No — direct connections only'}
            </option>
            <option value={1}>1 hop</option>
            <option value={2}>2 hops</option>
            <option value={3}>3 hops</option>
          </select>
        </label>

        {/* Audience — scope the post to specific sharing circles. Hidden when the
            household grants shareTo to no circle (a scoped post would reach nobody). */}
        {shareToCircles.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-text">Audience</legend>
            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Audience">
              <label className="flex min-h-11 items-center gap-3 rounded-lg border border-border px-3 text-sm text-text">
                <input
                  type="radio"
                  name="share-audience-mode"
                  data-testid="share-audience-mode-all"
                  checked={audience === 'ALL'}
                  onChange={() => setAudience('ALL')}
                  className="size-5 accent-[var(--color-accent)]"
                />
                All sharing circles
              </label>
              <label className="flex min-h-11 items-center gap-3 rounded-lg border border-border px-3 text-sm text-text">
                <input
                  type="radio"
                  name="share-audience-mode"
                  data-testid="share-audience-mode-select"
                  checked={audience === 'SELECT'}
                  onChange={() => setAudience('SELECT')}
                  className="size-5 accent-[var(--color-accent)]"
                />
                Only these circles…
              </label>
            </div>

            {audience === 'SELECT' && (
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <ul className="flex flex-col gap-1">
                  {shareToCircles.map((c) => (
                    <li key={c.id}>
                      <label
                        data-testid="share-audience-circle"
                        className="flex min-h-11 items-center gap-3 text-sm text-text"
                      >
                        <input
                          type="checkbox"
                          checked={audienceCircles.has(c.id)}
                          onChange={(e) =>
                            setAudienceCircles((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(c.id);
                              else next.delete(c.id);
                              return next;
                            })
                          }
                          className="size-5 accent-[var(--color-accent)]"
                        />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-text-muted">Limited posts can&apos;t be reshared.</p>
              </div>
            )}
          </fieldset>
        )}

        {/* Photo */}
        <div className="flex items-center gap-3">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photo.preview}
              alt=""
              className="size-16 shrink-0 rounded-lg border border-border object-cover"
            />
          ) : (
            <span className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-muted">
              🖼
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            data-testid="share-photo-input"
            onChange={(e) => handleFile(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : photo ? 'Replace photo' : 'Photo (optional)'}
          </button>
        </div>

        {/* Surplus-only: link tracked pantry lots to gift from. */}
        {type === 'SURPLUS' && lots.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <button
              type="button"
              data-testid="share-lots-toggle"
              onClick={() => setLotsOpen((o) => !o)}
              className="flex min-h-11 items-center justify-between gap-2 text-left text-sm font-medium text-text"
            >
              <span>
                Link tracked pantry lots
                {selectedLots.size > 0 && (
                  <span className="font-normal text-text-muted"> · {selectedLots.size} linked</span>
                )}
              </span>
              <span className="text-text-muted">{lotsOpen ? '▾' : '▸'}</span>
            </button>
            {lotsOpen && (
              <>
                <p className="text-xs text-text-muted">
                  Linked lots hand off as a $0 gift when you confirm a claim — the units leave your
                  pantry, no ledger entry, ever.
                </p>
                <ul className="flex flex-col gap-1">
                  {lots.map((lot) => (
                    <li key={lot.id}>
                      <label className="flex min-h-11 items-center gap-3 text-sm text-text">
                        <input
                          type="checkbox"
                          data-testid={`share-lot-${lot.id}`}
                          checked={selectedLots.has(lot.id)}
                          onChange={(e) =>
                            setSelectedLots((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(lot.id);
                              else next.delete(lot.id);
                              return next;
                            })
                          }
                          className="size-5 accent-[var(--color-accent)]"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {lot.productName}{' '}
                          <span className="font-mono text-xs text-text-muted">{lot.code}</span>
                        </span>
                        <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                          {lot.available} avail
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {audienceIncomplete && (
          <p className="text-xs text-text-muted">Pick at least one circle, or post to all.</p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button
            type="submit"
            data-testid="share-compose-submit"
            disabled={create.isPending || uploading || audienceIncomplete}
            className={primaryBtn}
          >
            {create.isPending ? 'Posting…' : 'Post'}
          </button>
        </div>
      </form>
    </div>
  );
}
